// End to end: the page renders with the kit, filters narrow the results region, unknown values say so, details render.
import { test } from "node:test";
import assert from "node:assert/strict";
import { server } from "../server.mjs";

test("list, filter, detail and health", async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const home = await (await fetch(`${base}/`)).text();
    assert.match(home, /design-system\/kit\.js/);
    assert.match(home, /data-autoapply data-target="#results"/);
    assert.match(home, /4 of 4 items/);
    assert.match(await (await fetch(`${base}/?status=late`)).text(), /1 of 4 items/);
    assert.match(await (await fetch(`${base}/?q=zzz`)).text(), /No items match these filters/);
    assert.match(await (await fetch(`${base}/?status=bogus`)).text(), /Unknown status/);
    assert.match(await (await fetch(`${base}/items/search-v2`)).text(), /data-drawer-content/);
    assert.equal((await fetch(`${base}/design-system/tokens.css`)).status, 200);
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), { ok: true, checks: [] });
  } finally {
    server.close();
  }
});
