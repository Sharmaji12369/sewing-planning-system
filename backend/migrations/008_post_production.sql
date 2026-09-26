-- Post-production (22 Sep 2026): packing, ticked once an order is complete and
-- due 4 days after it (planning.ts, PACKING_DAYS).

ALTER TABLE orders ADD COLUMN packed_at timestamptz;

-- The new page follows pre-production access: who could see pre-production can
-- see post-production, and who could tick pre-production can tick packing.
UPDATE roles SET permissions = array_append(permissions, 'postproduction.view')
 WHERE ('preproduction.view' = ANY (permissions) OR 'preproduction.edit' = ANY (permissions))
   AND NOT 'postproduction.view' = ANY (permissions);
UPDATE roles SET permissions = array_append(permissions, 'postproduction.edit')
 WHERE 'preproduction.edit' = ANY (permissions)
   AND NOT 'postproduction.edit' = ANY (permissions);
