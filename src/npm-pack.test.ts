import assert from "node:assert/strict";
import test from "node:test";
import { packRecords, packedContracts } from "./npm-pack.ts";

const contracts = { name: "@plurnk/plurnk-contracts", version: "1.0.0", filename: "plurnk-plurnk-contracts-1.0.0.tgz" };
const service = { name: "@plurnk/plurnk-service", version: "1.0.0", filename: "plurnk-plurnk-service-1.0.0.tgz" };

test("{§bench-relock} npm 11's pack array and npm 12's name-keyed envelope yield the same records", () => {
    const expected = [contracts, service];
    assert.deepEqual(packRecords(JSON.stringify([contracts, service])), expected, "npm 11: an array of records");
    assert.deepEqual(packRecords(JSON.stringify({ [contracts.name]: contracts, [service.name]: service })), expected, "npm 12: records keyed by package name");
    assert.deepEqual(packRecords(JSON.stringify([{ ...contracts, files: [], size: 1 }])), [contracts], "only the artifact identity is kept");
    assert.throws(() => packRecords("[]"), /no artifacts/, "nothing packed");
    assert.throws(() => packRecords("{}"), /no artifacts/, "nothing packed, keyed form");
    assert.throws(() => packRecords("null"), /no artifacts/, "no envelope");
    assert.throws(() => packRecords(JSON.stringify([{ name: contracts.name, version: "1.0.0" }])), /without a name, version or filename/, "a record without an archive name");
});

test("{§bench-relock} the candidate client takes exactly the contracts package from either envelope", () => {
    assert.deepEqual(packedContracts(JSON.stringify([contracts])), contracts);
    assert.deepEqual(packedContracts(JSON.stringify({ [contracts.name]: contracts })), contracts);
    const refused = /did not pack its contracts/;
    assert.throws(() => packedContracts("[]"), refused, "nothing packed");
    assert.throws(() => packedContracts(JSON.stringify([contracts, service])), refused, "more than the contracts");
    assert.throws(() => packedContracts(JSON.stringify({ [service.name]: service })), refused, "the wrong package");
    assert.throws(() => packedContracts(JSON.stringify([{ name: contracts.name, version: "1.0.0" }])), refused, "a record without an archive name");
});
