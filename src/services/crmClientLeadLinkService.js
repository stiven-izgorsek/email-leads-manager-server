import { AppDataSource } from '../config/database.js';
import { Client } from '../entities/Client.js';

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * Recompute is_in_crm_client for one lead row (by id and/or email).
 */
export async function refreshClientCrmLinkFlag({ leadId = null, email = null } = {}) {
  const id = leadId ? String(leadId).trim() : null;
  const normalizedEmail = normalizeEmail(email);
  if (!id && !normalizedEmail) return 0;

  const params = [];
  const matchParts = [];
  if (id) {
    params.push(id);
    matchParts.push(`c.id = $${params.length}`);
  }
  if (normalizedEmail) {
    params.push(normalizedEmail);
    matchParts.push(`LOWER(TRIM(c.email)) = $${params.length}`);
  }

  const result = await AppDataSource.manager.query(
    `
    WITH targets AS (
      SELECT c.id
      FROM client c
      WHERE c."deletedAt" IS NULL
        AND (${matchParts.join(' OR ')})
    ),
    flags AS (
      SELECT
        t.id,
        EXISTS (
          SELECT 1 FROM crm_client cc
          WHERE cc."deletedAt" IS NULL
            AND (
              cc."leadId" = t.id
              OR (
                cc.email IS NOT NULL
                AND TRIM(cc.email) <> ''
                AND LOWER(TRIM(cc.email)) = LOWER(TRIM((SELECT email FROM client WHERE id = t.id)))
              )
            )
        ) AS in_crm
      FROM targets t
    )
    UPDATE client c
    SET
      is_in_crm_client = f.in_crm,
      "updatedAt" = NOW()
    FROM flags f
    WHERE c.id = f.id
    RETURNING c.id
    `,
    params
  );

  return Array.isArray(result) ? result.length : 0;
}

/** Mark lead(s) as linked to CRM after create/update. */
export async function markClientsLinkedToCrm({ leadId = null, email = null } = {}) {
  const clientRepo = AppDataSource.getRepository(Client);
  const id = leadId ? String(leadId).trim() : null;
  const normalizedEmail = normalizeEmail(email);

  if (id) {
    await clientRepo.update({ id }, { isInCrmClient: true, updatedAt: new Date() });
  }
  if (normalizedEmail) {
    await clientRepo
      .createQueryBuilder()
      .update(Client)
      .set({ isInCrmClient: true, updatedAt: new Date() })
      .where('"deletedAt" IS NULL')
      .andWhere('LOWER(TRIM(email)) = :email', { email: normalizedEmail })
      .execute();
  }
}

/** One-time / startup backfill from crm_client. */
export async function backfillClientCrmLinkFlags() {
  await AppDataSource.manager.query(`
    UPDATE client c
    SET is_in_crm_client = false, "updatedAt" = NOW()
    WHERE c."deletedAt" IS NULL
      AND c.is_in_crm_client = true
  `);

  const result = await AppDataSource.manager.query(`
    UPDATE client c
    SET is_in_crm_client = true, "updatedAt" = NOW()
    WHERE c."deletedAt" IS NULL
      AND EXISTS (
        SELECT 1 FROM crm_client cc
        WHERE cc."deletedAt" IS NULL
          AND (
            cc."leadId" = c.id
            OR (
              cc.email IS NOT NULL
              AND TRIM(cc.email) <> ''
              AND LOWER(TRIM(cc.email)) = LOWER(TRIM(c.email))
            )
          )
      )
    RETURNING c.id
  `);

  const updated = Array.isArray(result) ? result.length : 0;
  if (updated > 0) {
    console.log(`[crm-link] backfilled is_in_crm_client for ${updated} lead(s)`);
  }
  return { updated };
}
