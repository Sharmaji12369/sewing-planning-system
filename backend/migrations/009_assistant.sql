-- The Assistant (23 Sep 2026): a local "ask the board" agent and its
-- suggestions. It only reads, so anyone who can see the dashboard can use it.

UPDATE roles SET permissions = array_append(permissions, 'assistant.use')
 WHERE ('dashboard.view' = ANY (permissions) OR 'orders.view' = ANY (permissions))
   AND NOT 'assistant.use' = ANY (permissions);
