const test = require("node:test");
const assert = require("node:assert/strict");

test("role promotion matrix is explicit", () => {
  const canPromote = (actor, target) => ["owner", "developer"].includes(actor)
    ? ["ar", "manager", "developer"].includes(target)
    : actor === "manager" && target === "ar";
  assert.equal(canPromote("owner", "manager"), true);
  assert.equal(canPromote("owner", "ar"), true);
  assert.equal(canPromote("developer", "developer"), true);
  assert.equal(canPromote("developer", "manager"), true);
  assert.equal(canPromote("manager", "ar"), true);
  assert.equal(canPromote("manager", "manager"), false);
  assert.equal(canPromote("ar", "manager"), false);
});

test("public role and status values remain constrained", () => {
  const cleanRole = (role) => ["artist", "ar", "manager", "owner", "developer"].includes(role) ? role : "artist";
  assert.equal(cleanRole("manager"), "manager");
  assert.equal(cleanRole("developer"), "developer");
  assert.equal(cleanRole("anything"), "artist");
});
