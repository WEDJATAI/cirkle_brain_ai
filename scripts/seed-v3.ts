// Quick V3-only seed script — avoids re-running the full seed (which takes
// minutes against remote Neon). Run: DATABASE_URL=... npx tsx scripts/seed-v3.ts
import { seedGeneralKnowledgeV3 } from "../src/lib/brain/knowledge-base-v3";
import { db } from "../src/lib/db";

(async () => {
  const tenant = await db.tenant.findUnique({ where: { slug: "acme" } });
  const app = await db.application.findFirst({ where: { tenantId: tenant!.id, slug: "mashahd" } });
  if (!tenant || !app) {
    console.error("Tenant/application not found. Run the full seed first.");
    process.exit(1);
  }
  console.log("Seeding Knowledge V3...");
  const result = await seedGeneralKnowledgeV3(tenant.id, app.id);
  console.log(`✓ Seeded ${result.itemCount} V3 knowledge items (source: ${result.sourceId})`);
  const total = await db.knowledgeItem.count({ where: { status: "ACTIVE" } });
  console.log(`Total active knowledge items: ${total}`);
  await db.$disconnect();
  process.exit(0);
})();
