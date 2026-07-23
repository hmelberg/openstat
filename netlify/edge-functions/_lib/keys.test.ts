import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// js/keys.js is a classic script on window/globalThis (same eval harness as
// data-loader.test.ts). Each call re-evals with a fresh localStorage shim so
// tests are isolated and the load-time migration runs per test.
function freshKeys(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const mock = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  };
  // Deno's localStorage has custom descriptors; use defineProperty to override
  Object.defineProperty(globalThis, "localStorage", {
    value: mock,
    writable: true,
    configurable: true,
  });
  const src = Deno.readTextFileSync(new URL("../../../js/keys.js", import.meta.url));
  (0, eval)(src);
  // deno-lint-ignore no-explicit-any
  return { Keys: (globalThis as any).Keys, store };
}

Deno.test("Keys: get/set/remove/registered round-trip via md_keys", () => {
  const { Keys, store } = freshKeys();
  assertEquals(Keys.get("kaggle"), "");
  Keys.set("kaggle", "bruker:K1");
  Keys.set("fred", "F1");
  assertEquals(Keys.get("kaggle"), "bruker:K1");
  assertEquals(Keys.registered().sort(), ["fred", "kaggle"]);
  Keys.remove("fred");
  assertEquals(Keys.get("fred"), "");
  assertEquals(Keys.registered(), ["kaggle"]);
  assertEquals(JSON.parse(store.get("md_keys")!), { kaggle: "bruker:K1" });
});

Deno.test("Keys: migrates legacy md_anthropic_key and removes it", () => {
  const { Keys, store } = freshKeys({ "md_anthropic_key": "sk-ant-legacy" });
  assertEquals(Keys.get("anthropic"), "sk-ant-legacy");
  assertEquals(store.has("md_anthropic_key"), false);
});

Deno.test("Keys: corrupt md_keys JSON degrades to empty, set() repairs", () => {
  const { Keys } = freshKeys({ "md_keys": "{not json" });
  assertEquals(Keys.get("anthropic"), "");
  Keys.set("anthropic", "sk-ant-x");
  assertEquals(Keys.get("anthropic"), "sk-ant-x");
});
