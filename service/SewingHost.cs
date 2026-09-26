// SewingHost - runs one Node program as a Windows service.
//
//   SewingHost.exe <file.conf>             started by Windows as a service
//   SewingHost.exe <file.conf> --console   the same in a console window, for testing
//
// The .conf file names the program, its folder, its log and any extra
// environment variables. If the program exits it is started again after 5 s,
// backing off to 60 s while it keeps failing. The program and everything it
// starts run inside a job object, so stopping the service - or this host
// dying - ends all of them and nothing is left holding the port.
//
// Built by install-services.ps1 with the C# compiler that ships with Windows
// (.NET Framework 4, C# 5 - no string interpolation, no ?.).

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Text;
using System.Threading;

namespace SewingHost
{
    sealed class Config
    {
        public string Name, Exe, Args = "", WorkDir, Log;
        public readonly Dictionary<string, string> Env = new Dictionary<string, string>();

        // key=value lines, # comments. Relative paths are from the .conf file's folder.
        public static Config Load(string path)
        {
            path = Path.GetFullPath(path);
            string dir = Path.GetDirectoryName(path);
            var c = new Config();
            foreach (string raw in File.ReadAllLines(path))
            {
                string line = raw.Trim();
                if (line.Length == 0 || line[0] == '#') continue;
                int eq = line.IndexOf('=');
                if (eq < 1) throw new FormatException(path + ": expected key=value, got: " + line);
                string key = line.Substring(0, eq).Trim(), value = line.Substring(eq + 1).Trim();
                if (key.StartsWith("env.")) c.Env[key.Substring(4)] = value;
                else if (key == "name") c.Name = value;
                else if (key == "exe") c.Exe = value;
                else if (key == "args") c.Args = value;
                else if (key == "workdir") c.WorkDir = Path.GetFullPath(Path.Combine(dir, value));
                else if (key == "log") c.Log = Path.GetFullPath(Path.Combine(dir, value));
                else throw new FormatException(path + ": unknown key '" + key + "'");
            }
            if (c.Name == null || c.Exe == null || c.WorkDir == null || c.Log == null)
                throw new FormatException(path + ": name, exe, workdir and log are all required");
            return c;
        }
    }

    // Timestamped lines, rolled over to <log>.1 at 10 MB. Never throws: a locked
    // or full disk must not take the site down.
    sealed class LogFile
    {
        const long MaxBytes = 10L * 1024 * 1024;
        readonly string path;
        readonly object gate = new object();
        StreamWriter writer;
        public bool Echo;

        public LogFile(string path)
        {
            this.path = path;
            Directory.CreateDirectory(Path.GetDirectoryName(path));
        }

        public void Write(string line)
        {
            string stamped = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + line;
            lock (gate)
            {
                try
                {
                    if (writer != null && writer.BaseStream.Length > MaxBytes)
                    {
                        writer.Dispose();
                        writer = null;
                        File.Delete(path + ".1");
                        File.Move(path, path + ".1");
                    }
                }
                catch (Exception) { }
                try
                {
                    if (writer == null)
                    {
                        var fs = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
                        // BOM on a new file only, so Windows PowerShell reads it as UTF-8.
                        writer = new StreamWriter(fs, new UTF8Encoding(true));
                        writer.AutoFlush = true;
                    }
                    writer.WriteLine(stamped);
                }
                catch (Exception) { writer = null; }
            }
            if (Echo) Console.WriteLine(stamped);
        }
    }

    static class Job
    {
        [StructLayout(LayoutKind.Sequential)]
        struct BasicLimits
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct IoCounters
        {
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
            public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct ExtendedLimits
        {
            public BasicLimits Basic;
            public IoCounters Io;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        const int ExtendedLimitInformation = 9;
        const uint KillOnJobClose = 0x2000;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int size);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool TerminateJobObject(IntPtr job, uint exitCode);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CloseHandle(IntPtr handle);

        // A job that ends every process in it when its last handle is closed.
        public static IntPtr Create()
        {
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception();
            var info = new ExtendedLimits();
            info.Basic.LimitFlags = KillOnJobClose;
            if (!SetInformationJobObject(job, ExtendedLimitInformation, ref info, Marshal.SizeOf(typeof(ExtendedLimits))))
            {
                var err = new Win32Exception();
                CloseHandle(job);
                throw err;
            }
            return job;
        }

        public static void Assign(IntPtr job, Process p)
        {
            if (!AssignProcessToJobObject(job, p.Handle)) throw new Win32Exception();
        }

        public static void Kill(IntPtr job) { TerminateJobObject(job, 1); }
        public static void Close(IntPtr job) { CloseHandle(job); }
    }

    sealed class Runner
    {
        readonly Config c;
        readonly LogFile log;
        readonly ManualResetEvent stopRequested = new ManualResetEvent(false);
        readonly object gate = new object();
        IntPtr job = IntPtr.Zero;
        Thread thread;

        public Runner(Config c, LogFile log) { this.c = c; this.log = log; }

        bool Stopping { get { return stopRequested.WaitOne(0); } }

        public void Start()
        {
            log.Write("=== " + c.Name + " starting");
            thread = new Thread(Loop);
            thread.IsBackground = true;
            thread.Start();
        }

        public void Stop()
        {
            stopRequested.Set();
            lock (gate) { if (job != IntPtr.Zero) Job.Kill(job); }
            if (thread != null) thread.Join(15000);
            log.Write("=== " + c.Name + " stopped");
        }

        void Loop()
        {
            int quickFailures = 0;
            while (!Stopping)
            {
                DateTime started = DateTime.UtcNow;
                int code = RunOnce();
                if (Stopping) return;
                double ran = (DateTime.UtcNow - started).TotalSeconds;
                quickFailures = ran < 60 ? quickFailures + 1 : 0;
                int wait = Math.Min(60, 5 * Math.Max(1, quickFailures));
                log.Write(string.Format("exited with code {0} after {1:0} s - starting it again in {2} s", code, ran, wait));
                if (stopRequested.WaitOne(wait * 1000)) return;
            }
        }

        int RunOnce()
        {
            var psi = new ProcessStartInfo(c.Exe, c.Args);
            psi.WorkingDirectory = c.WorkDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;
            foreach (var kv in c.Env) psi.EnvironmentVariables[kv.Key] = kv.Value;

            var p = new Process();
            p.StartInfo = psi;
            p.OutputDataReceived += (s, e) => { if (e.Data != null) log.Write(e.Data); };
            p.ErrorDataReceived += (s, e) => { if (e.Data != null) log.Write(e.Data); };

            IntPtr j;
            try { j = Job.Create(); }
            catch (Exception ex) { log.Write("could not create a job object: " + ex.Message); return -1; }
            try { p.Start(); }
            catch (Exception ex)
            {
                Job.Close(j);
                log.Write("could not start " + c.Exe + ": " + ex.Message);
                return -1;
            }
            bool inJob = true;
            try { Job.Assign(j, p); }
            catch (Exception ex) { inJob = false; log.Write("warning: could not put the program in a job: " + ex.Message); }
            lock (gate) { job = j; }
            if (Stopping) Job.Kill(j);   // Stop() ran before the job was published

            log.Write("started " + Path.GetFileName(c.Exe) + " " + c.Args + " (pid " + p.Id + ") in " + c.WorkDir);
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();

            // A finite wait: WaitForExit() with no timeout also waits for the output
            // pipes to close, which a leftover child process could hold open.
            while (!p.WaitForExit(1000)) { }
            int code = p.ExitCode;
            lock (gate)
            {
                Job.Kill(j);   // anything it left running
                Job.Close(j);
                job = IntPtr.Zero;
            }
            if (inJob) p.WaitForExit();   // now safe: lets the last output lines reach the log
            p.Dispose();
            return code;
        }
    }

    sealed class HostService : ServiceBase
    {
        readonly Runner runner;

        public HostService(Config c, Runner runner)
        {
            ServiceName = c.Name;
            CanStop = true;
            CanShutdown = true;
            AutoLog = false;
            this.runner = runner;
        }

        protected override void OnStart(string[] args) { runner.Start(); }
        protected override void OnStop() { runner.Stop(); }
        protected override void OnShutdown() { runner.Stop(); }
    }

    static class Program
    {
        static int Main(string[] args)
        {
            if (args.Length < 1)
            {
                Console.Error.WriteLine("usage: SewingHost.exe <file.conf> [--console]");
                return 2;
            }

            Config c;
            try { c = Config.Load(args[0]); }
            catch (Exception ex)
            {
                // As a service there is no console; leave the reason beside the host.
                try
                {
                    File.AppendAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "SewingHost-error.txt"),
                        DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + ex.Message + Environment.NewLine);
                }
                catch (Exception) { }
                Console.Error.WriteLine(ex.Message);
                return 2;
            }

            var log = new LogFile(c.Log);
            var runner = new Runner(c, log);

            if (Array.IndexOf(args, "--console") < 0 && !Environment.UserInteractive)
            {
                ServiceBase.Run(new HostService(c, runner));
                return 0;
            }

            log.Echo = true;
            Console.CancelKeyPress += (s, e) => { e.Cancel = true; runner.Stop(); Environment.Exit(0); };
            runner.Start();
            Thread.Sleep(Timeout.Infinite);
            return 0;
        }
    }
}
