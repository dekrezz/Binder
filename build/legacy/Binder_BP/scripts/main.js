/**
 * Binder — on-screen keybinder for Minecraft Bedrock.
 * by dekrezz
 *
 * Bedrock's scripting API cannot read the keyboard, so the menu is opened by:
 *   1) using (right-click) the custom item  dekrezz:binder
 *   2) jumping JUMP_COMBO_COUNT times in a row (no /give needed)
 *   3) double-tapping Sneak (Shift) within DOUBLE_TAP_TICKS
 *   4) /scriptevent dekrezz:binder
 *
 * Input is polled via Player.isJumping / Player.isSneaking instead of the
 * playerButtonInput event, which is missing on some builds.
 */

import { world, system } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";

const PROP_BINDS = "binder:binds";
const ITEM_ID = "dekrezz:binder";
const DOUBLE_TAP_TICKS = 8;
const JUMP_COMBO_COUNT = 7;
const JUMP_COMBO_WINDOW_TICKS = 20; // max gap between two jumps of the combo
const JUMP_STRENGTH = 0.65;

const TYPES = ["command", "jump"];
const TYPE_LABELS = ["Command", "Jump"];

const DEFAULT_BINDS = [
  { name: "Jump", type: "jump", value: "" },
  { name: "Day", type: "command", value: "/time set day" },
  { name: "Clear weather", type: "command", value: "/weather clear" },
];

/* ---------- storage ---------- */

function loadBinds(player) {
  const raw = player.getDynamicProperty(PROP_BINDS);
  if (raw === undefined) return DEFAULT_BINDS.map((b) => ({ ...b }));
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Binder: dynamic property ${PROP_BINDS} is not an array`);
  }
  return parsed;
}

function saveBinds(player, binds) {
  player.setDynamicProperty(PROP_BINDS, JSON.stringify(binds));
}

/* ---------- actions ---------- */

let knockbackSignature; // "v2" = (VectorXZ, vertical), "v1" = (dx, dz, h, v)

function jump(player) {
  if (knockbackSignature !== "v1") {
    try {
      player.applyKnockback({ x: 0, z: 0 }, JUMP_STRENGTH);
      knockbackSignature = "v2";
      return;
    } catch (e) {
      if (knockbackSignature === "v2") throw e;
      console.warn(`Binder: applyKnockback(VectorXZ, number) failed (${e}), using legacy signature`);
      knockbackSignature = "v1";
    }
  }
  player.applyKnockback(0, 0, 0, JUMP_STRENGTH);
}

function runBind(player, bind) {
  if (bind.type === "jump") {
    jump(player);
    return;
  }
  if (bind.type === "command") {
    const commands = String(bind.value)
      .split(";")
      .map((c) => c.trim().replace(/^\//, ""))
      .filter((c) => c.length > 0);
    if (commands.length === 0) {
      player.sendMessage("§cBinder: bind has no command");
      return;
    }
    for (const cmd of commands) player.runCommand(cmd);
    return;
  }
  throw new Error(`Binder: unknown bind type "${bind.type}"`);
}

/* ---------- UI ---------- */

function openMenu(player) {
  const binds = loadBinds(player);
  const form = new ActionFormData()
    .title("Binder")
    .body(
      binds.length > 0
        ? "§7by dekrezz§r\nClick a bind to run it."
        : "§7by dekrezz§r\nNo binds yet — add one below."
    );

  for (const bind of binds) {
    form.button(`${bind.name}\n§7${bind.type === "jump" ? "jump" : bind.value}`);
  }
  form.button("§a+ Add bind");
  if (binds.length > 0) form.button("§eEdit / delete");

  form.show(player).then((res) => {
    if (res.canceled) return;
    const i = res.selection;
    if (i < binds.length) {
      runBind(player, binds[i]);
      return;
    }
    if (i === binds.length) {
      openEditor(player, binds, -1);
      return;
    }
    openBindList(player, binds);
  });
}

function openBindList(player, binds) {
  const form = new ActionFormData().title("Binder — edit").body("Pick a bind to edit.");
  for (const bind of binds) form.button(`${bind.name}\n§7${bind.type}`);
  form.button("§8< Back");

  form.show(player).then((res) => {
    if (res.canceled) return;
    if (res.selection === binds.length) {
      openMenu(player);
      return;
    }
    openEditor(player, binds, res.selection);
  });
}

function openEditor(player, binds, index) {
  const isNew = index < 0;
  const bind = isNew ? { name: "", type: "command", value: "" } : binds[index];
  const typeIndex = Math.max(0, TYPES.indexOf(bind.type));

  const form = new ModalFormData()
    .title(isNew ? "Binder — new bind" : "Binder — edit bind")
    .textField("Button name", "e.g. Day", bind.name)
    .dropdown("Action", TYPE_LABELS, typeIndex)
    .textField("Command (several: separate with ;)", "/time set day", bind.value);
  if (!isNew) form.toggle("Delete this bind", false);

  form.show(player).then((res) => {
    if (res.canceled) return;
    const [name, type, value, remove] = res.formValues;

    if (!isNew && remove === true) {
      binds.splice(index, 1);
      saveBinds(player, binds);
      player.sendMessage("§aBinder: bind deleted");
      openMenu(player);
      return;
    }

    const trimmedName = String(name).trim();
    if (trimmedName.length === 0) {
      player.sendMessage("§cBinder: name cannot be empty");
      return;
    }
    const next = { name: trimmedName, type: TYPES[type], value: String(value).trim() };
    if (next.type === "command" && next.value.length === 0) {
      player.sendMessage("§cBinder: command cannot be empty");
      return;
    }

    if (isNew) binds.push(next);
    else binds[index] = next;
    saveBinds(player, binds);
    player.sendMessage("§aBinder: saved");
    openMenu(player);
  });
}

/* ---------- triggers ---------- */

// itemUse / scriptEvent handlers may be read-only, so defer by one tick there.
function requestMenu(player) {
  system.run(() => openMenu(player));
}

world.afterEvents.itemUse.subscribe((event) => {
  if (event.itemStack?.typeId === ITEM_ID) requestMenu(event.source);
});

const inputState = new Map(); // player id -> { jumping, sneaking, jumps, jumpTick, sneakTick }

function stateFor(id) {
  let state = inputState.get(id);
  if (state === undefined) {
    state = { jumping: false, sneaking: false, jumps: 0, jumpTick: -999, sneakTick: -999 };
    inputState.set(id, state);
  }
  return state;
}

system.runInterval(() => {
  const now = system.currentTick;
  for (const player of world.getAllPlayers()) {
    const state = stateFor(player.id);

    const jumping = player.isJumping;
    if (jumping && !state.jumping) {
      state.jumps = now - state.jumpTick <= JUMP_COMBO_WINDOW_TICKS ? state.jumps + 1 : 1;
      state.jumpTick = now;

      if (state.jumps >= JUMP_COMBO_COUNT) {
        state.jumps = 0;
        openMenu(player);
      } else if (state.jumps >= Math.ceil(JUMP_COMBO_COUNT / 2)) {
        player.onScreenDisplay.setActionBar(`§6Binder §7${state.jumps}/${JUMP_COMBO_COUNT}`);
      }
    }
    state.jumping = jumping;

    const sneaking = player.isSneaking;
    if (sneaking && !state.sneaking) {
      if (now - state.sneakTick <= DOUBLE_TAP_TICKS) {
        state.sneakTick = -999;
        openMenu(player);
      } else {
        state.sneakTick = now;
      }
    }
    state.sneaking = sneaking;
  }
}, 1);

world.afterEvents.playerLeave.subscribe((event) => {
  inputState.delete(event.playerId);
});

system.afterEvents.scriptEventReceive.subscribe((event) => {
  if (event.id !== "dekrezz:binder") return;
  const source = event.sourceEntity;
  if (source?.typeId !== "minecraft:player") return;
  requestMenu(source);
});

console.warn("Binder 1.0.2 loaded (legacy API 1.x)");

world.afterEvents.playerSpawn.subscribe((event) => {
  if (!event.initialSpawn) return;
  event.player.sendMessage(
    `§6Binder 1.0.2 (legacy) §7by dekrezz§r — open it by jumping ${JUMP_COMBO_COUNT}x in a row, double-tapping Shift, using the Binder item, or /scriptevent dekrezz:binder`
  );
});
