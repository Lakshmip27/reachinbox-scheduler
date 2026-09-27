import { ensureEmailIndex } from "../services/searchIndex";

ensureEmailIndex()
  .then(() => {
    console.log("✅ Elasticsearch index ready");
    process.exit(0);
  })
  .catch((err) => {
    console.error("❌ Failed to create Elasticsearch index", err);
    process.exit(1);
  });
