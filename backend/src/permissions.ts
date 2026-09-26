// What a role can be allowed to do. Every API route checks one of these, and
// the Users & roles screen lists them - this file is the only list.
//
// Edit includes view: a role that may edit orders may also see them.

export const PERMISSIONS = [
  { key: 'dashboard.view', section: 'Dashboard', label: 'View the dashboard' },
  { key: 'orders.view', section: 'Orders', label: 'View orders' },
  { key: 'orders.edit', section: 'Orders', label: 'Add, update and delete orders' },
  { key: 'preproduction.view', section: 'Pre-production', label: 'View pre-production' },
  { key: 'preproduction.edit', section: 'Pre-production', label: 'Tick fabric, cutting and accessories' },
  { key: 'postproduction.view', section: 'Post-production', label: 'View post-production' },
  { key: 'postproduction.edit', section: 'Post-production', label: 'Tick packing' },
  { key: 'log.view', section: 'Production Log', label: 'View the production log' },
  { key: 'log.edit', section: 'Production Log', label: 'Add, edit and delete production entries' },
  { key: 'calendar.view', section: 'Calendar', label: 'View the calendar' },
  { key: 'calendar.edit', section: 'Calendar', label: 'Mark and remove idle days' },
  { key: 'lines.view', section: 'Line calendar', label: 'View the line calendar' },
  { key: 'assistant.use', section: 'Assistant', label: 'Ask the assistant and see its suggestions' },
  { key: 'admin.users', section: 'Administration', label: 'Add users, create roles and change access' },
] as const;

export type Permission = (typeof PERMISSIONS)[number]['key'];

export const ALL_PERMISSIONS: Permission[] = PERMISSIONS.map((p) => p.key);

export const isPermission = (s: string): s is Permission => (ALL_PERMISSIONS as string[]).includes(s);

/** The code of the built-in role that always holds every permission. */
export const ADMIN_ROLE = 'administrator';

/** What a set of granted permissions actually allows: every edit brings its view with it. */
export function effective(granted: Iterable<string>): Set<Permission> {
  const out = new Set<Permission>();
  for (const g of granted) {
    if (!isPermission(g)) continue;
    out.add(g);
    if (g.endsWith('.edit')) {
      const view = g.replace(/\.edit$/, '.view');
      if (isPermission(view)) out.add(view);
    }
  }
  return out;
}
