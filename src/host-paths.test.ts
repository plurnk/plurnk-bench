import assert from "node:assert/strict";
import test from "node:test";
import { operatorConfigPath } from "./host-paths.ts";

test("operatorConfigPath follows XDG while preserving an explicit bench override", () => {
    assert.equal(operatorConfigPath(undefined, {}, "/home/ada"), "/home/ada/.config/plurnk/.env");
    assert.equal(
        operatorConfigPath(undefined, { XDG_CONFIG_HOME: "/cfg" }, "/home/ada"),
        "/cfg/plurnk/.env",
    );
    assert.equal(
        operatorConfigPath(undefined, { XDG_CONFIG_HOME: "relative" }, "/home/ada"),
        "/home/ada/.config/plurnk/.env",
    );
    assert.equal(operatorConfigPath("~/operator.env", {}, "/home/ada"), "/home/ada/operator.env");
    assert.equal(operatorConfigPath("/run/operator.env", {}, "/home/ada"), "/run/operator.env");
});
