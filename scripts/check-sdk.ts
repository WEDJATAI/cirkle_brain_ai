import ZAI from "z-ai-web-dev-sdk";

(async () => {
  const zai = await ZAI.create();
  const keys = Object.keys(zai);
  console.log("SDK top-level keys:", keys);
  console.log("has embeddings:", "embeddings" in zai);
  console.log("has functions:", "functions" in zai);
  console.log("has chat:", "chat" in zai);
  console.log("has images:", "images" in zai);
  try {
    const r = await (zai as any).embeddings?.create({ model: "embedding-3", input: "hello world" });
    console.log("embeddings result keys:", r ? Object.keys(r) : "none");
    if (r?.data?.[0]?.embedding) console.log("embedding dim:", r.data[0].embedding.length);
  } catch (e) {
    console.log("embeddings error:", (e as Error)?.message?.slice(0, 200));
  }
  // Try functions list
  try {
    const fns = (zai as any).functions;
    if (fns) console.log("functions methods:", Object.keys(fns));
  } catch (e) {}
})();
