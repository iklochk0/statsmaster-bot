"use client";

import { useEffect, useMemo, useState } from "react";

type ApiResult<T> = { ok: boolean; error?: string; result?: T };

export default function Home() {
  const [pin, setPin] = useState("");
  const [kvkId, setKvkId] = useState<number | null>(null);
  const [kvkName, setKvkName] = useState("");
  const [dbCounts, setDbCounts] = useState<Record<string, number>>({});
  const [lastImportTs, setLastImportTs] = useState<string | null>(null);
  const [lastPlayerUpdateTs, setLastPlayerUpdateTs] = useState<string | null>(null);
  const [zoneTag, setZoneTag] = useState("");
  const [isScoring, setIsScoring] = useState(true);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [linksFile, setLinksFile] = useState<File | null>(null);
  const [backupInfo, setBackupInfo] = useState<{ xlsxPath: string; zipPath: string } | null>(null);
  const [statusMsg, setStatusMsg] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [rolePlayerId, setRolePlayerId] = useState("");
  const [roleOwnerId, setRoleOwnerId] = useState("");
  const [resetConfirm, setResetConfirm] = useState("");
  const [wipeConfirm, setWipeConfirm] = useState("");
  const [resetClearGoals, setResetClearGoals] = useState(true);
  const [resetClearImports, setResetClearImports] = useState(true);
  const [playerForm, setPlayerForm] = useState({
    playerId: "",
    name: "",
    power: "",
    kp: "",
    dead: "",
    t4: "",
    t5: "",
    lastUpdate: "",
  });
  const [playerStatus, setPlayerStatus] = useState("");

  useEffect(() => {
    const stored = localStorage.getItem("adminPin");
    if (stored) setPin(stored);
  }, []);

  useEffect(() => {
    if (pin) localStorage.setItem("adminPin", pin);
  }, [pin]);

  const headers = useMemo(() => {
    return pin ? { "x-admin-pin": pin } : {};
  }, [pin]);

  async function jget<T>(url: string): Promise<T> {
    const r = await fetch(url, { headers });
    return r.json();
  }
  async function jpost<T>(url: string, body?: unknown): Promise<T> {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body || {}),
    });
    return r.json();
  }

  async function refreshStatus() {
    const data = await jget<{
      ok: boolean;
      kvk_id?: number | null;
      counts?: Record<string, number>;
      lastImportTs?: string | null;
      lastPlayerUpdateTs?: string | null;
    }>(
      "/api/db/status"
    );
    if (data.ok) {
      setKvkId(data.kvk_id ?? null);
      setDbCounts(data.counts || {});
      setLastImportTs(data.lastImportTs ?? null);
      setLastPlayerUpdateTs(data.lastPlayerUpdateTs ?? null);
    }
  }

  async function startKvK() {
    setBusy("kvk");
    const res = await jpost<{ ok: boolean; kvk_id?: number; error?: string }>(
      "/api/kvk/start",
      { name: kvkName.trim() || null }
    );
    setStatusMsg(res.ok ? `Started KvK #${res.kvk_id}` : `Start failed: ${res.error}`);
    await refreshStatus();
    setBusy(null);
  }

  async function stopKvK() {
    setBusy("kvk");
    const res = await jpost<{ ok: boolean; kvk_id?: number; error?: string }>("/api/kvk/stop");
    setStatusMsg(res.ok ? `Stopped KvK #${res.kvk_id}` : `Stop failed: ${res.error}`);
    await refreshStatus();
    setBusy(null);
  }

  async function runImport() {
    if (!importFile) {
      setStatusMsg("Select an .xlsx file first.");
      return;
    }
    if (!zoneTag.trim()) {
      setStatusMsg("Zone tag is required.");
      return;
    }
    setBusy("import");

    const form = new FormData();
    form.append("file", importFile);
    form.append("zoneTag", zoneTag.trim());
    form.append("isScoring", isScoring ? "true" : "false");

    const r = await fetch("/api/import", {
      method: "POST",
      headers,
      body: form,
    });
    const data: ApiResult<{ importedCount: number }> = await r.json();
    setStatusMsg(
      data.ok
        ? `Import OK. Rows: ${data.result?.importedCount ?? 0}`
        : `Import failed: ${data.error}`
    );
    await refreshStatus();
    setBusy(null);
  }

  async function runLinksImport() {
    if (!linksFile) {
      setStatusMsg("Select an .xlsx file first.");
      return;
    }
    setBusy("links");

    const form = new FormData();
    form.append("file", linksFile);

    const r = await fetch("/api/import-links", {
      method: "POST",
      headers,
      body: form,
    });
    const data: ApiResult<{ discord_links: { ok: number; skipped: number }; account_links: { ok: number; skipped: number } }> =
      await r.json();
    setStatusMsg(
      data.ok
        ? `Links import OK. discord_links=${data.result?.discord_links?.ok ?? 0}, account_links=${data.result?.account_links?.ok ?? 0}`
        : `Links import failed: ${data.error}`
    );
    await refreshStatus();
    setBusy(null);
  }

  async function runBackup() {
    setBusy("backup");
    const data = await jpost<ApiResult<{ xlsxPath: string; zipPath: string }>>("/api/backup");
    if (data.ok && data.result) {
      setBackupInfo(data.result);
      setStatusMsg("Backup created.");
    } else {
      setStatusMsg(`Backup failed: ${data.error}`);
    }
    setBusy(null);
  }

  async function clearImports() {
    setBusy("db");
    const data = await jpost<ApiResult<unknown>>("/api/db/clear-imports");
    setStatusMsg(data.ok ? "Imports cleared." : `Clear failed: ${data.error}`);
    await refreshStatus();
    setBusy(null);
  }

  async function setRole(role: "farm" | "main") {
    setBusy("role");
    const data = await jpost<ApiResult<unknown>>("/api/roles/set", {
      role,
      playerId: rolePlayerId.trim(),
      ownerId: roleOwnerId.trim(),
    });
    setStatusMsg(data.ok ? `Role set: ${role}` : `Role failed: ${data.error}`);
    await refreshStatus();
    setBusy(null);
  }

  async function resetKvK() {
    setBusy("reset");
    const data = await jpost<ApiResult<{ goalsDeleted?: number; importsDeleted?: number }>>(
      "/api/kvk/reset",
      {
        confirm: resetConfirm.trim(),
        clearGoals: resetClearGoals,
        clearImports: resetClearImports,
      }
    );
    setStatusMsg(
      data.ok
        ? `KvK reset. goals=${data.result?.goalsDeleted ?? 0}, imports=${data.result?.importsDeleted ?? 0}`
        : `Reset failed: ${data.error}`
    );
    await refreshStatus();
    setBusy(null);
  }

  async function wipeDb() {
    setBusy("wipe");
    const data = await jpost<ApiResult<unknown>>("/api/db/wipe", {
      confirm: wipeConfirm.trim(),
    });
    setStatusMsg(data.ok ? "DB wiped." : `Wipe failed: ${data.error}`);
    await refreshStatus();
    setBusy(null);
  }

  function setPlayerField(key: keyof typeof playerForm, value: string) {
    setPlayerForm((prev) => ({ ...prev, [key]: value }));
  }

  async function loadPlayer() {
    const id = playerForm.playerId.trim();
    if (!id) {
      setPlayerStatus("Enter player_id first.");
      return;
    }
    setBusy("player");
    const data = await jpost<ApiResult<any>>("/api/players/get", { playerId: id });
    if (data.ok && data.result) {
      setPlayerForm({
        playerId: String(data.result.player_id ?? id),
        name: data.result.name ?? "",
        power: String(data.result.power_current ?? 0),
        kp: String(data.result.kp_current ?? 0),
        dead: String(data.result.dead_current ?? 0),
        t4: String(data.result.t4_kills_current ?? 0),
        t5: String(data.result.t5_kills_current ?? 0),
        lastUpdate: data.result.last_update ? String(data.result.last_update) : "",
      });
      setPlayerStatus("Player loaded.");
    } else {
      setPlayerStatus(`Load failed: ${data.error}`);
    }
    setBusy(null);
  }

  async function savePlayer() {
    const id = playerForm.playerId.trim();
    if (!id) {
      setPlayerStatus("player_id is required.");
      return;
    }
    setBusy("player");
    const data = await jpost<ApiResult<any>>("/api/players/upsert", {
      player_id: id,
      name: playerForm.name,
      power_current: playerForm.power,
      kp_current: playerForm.kp,
      dead_current: playerForm.dead,
      t4_kills_current: playerForm.t4,
      t5_kills_current: playerForm.t5,
      last_update: playerForm.lastUpdate || null,
    });
    setPlayerStatus(data.ok ? "Player saved." : `Save failed: ${data.error}`);
    await refreshStatus();
    setBusy(null);
  }

  useEffect(() => {
    refreshStatus().catch(() => {});
  }, []);

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>StatsMaster Admin</h1>
          <p className="muted">Local panel for KvK, import/export, and DB actions.</p>
        </div>
        <div className="pin">
          <label>PIN</label>
          <input
            type="password"
            placeholder="Set ADMIN_PIN in env"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
        </div>
      </header>

      <section className="grid">
        <div className="card">
          <h2>KvK</h2>
          <div className="row">
            <div className="pill">Active: {kvkId ?? "none"}</div>
            <button onClick={refreshStatus} disabled={busy === "kvk"}>
              Refresh
            </button>
          </div>
          <div className="row">
            <input
              type="text"
              placeholder="KvK name (optional)"
              value={kvkName}
              onChange={(e) => setKvkName(e.target.value)}
            />
            <button onClick={startKvK} disabled={busy === "kvk"}>
              Start
            </button>
            <button onClick={stopKvK} disabled={busy === "kvk"}>
              Stop
            </button>
          </div>
        </div>

        <div className="card">
          <h2>Import</h2>
          <div className="row">
            <input type="file" accept=".xlsx" onChange={(e) => setImportFile(e.target.files?.[0] ?? null)} />
          </div>
          <div className="row">
            <input
              type="text"
              placeholder="zone_tag (e.g. zone4)"
              value={zoneTag}
              onChange={(e) => setZoneTag(e.target.value)}
            />
            <label className="checkbox">
              <input
                type="checkbox"
                checked={isScoring}
                onChange={(e) => setIsScoring(e.target.checked)}
              />
              Scoring
            </label>
            <button onClick={runImport} disabled={busy === "import"}>
              Import
            </button>
          </div>
        </div>

        <div className="card">
          <h2>Import Links</h2>
          <div className="row">
            <input type="file" accept=".xlsx" onChange={(e) => setLinksFile(e.target.files?.[0] ?? null)} />
          </div>
          <div className="row">
            <button onClick={runLinksImport} disabled={busy === "links"}>
              Import discord_links + account_links
            </button>
          </div>
        </div>

        <div className="card">
          <h2>Backup</h2>
          <div className="row">
            <button onClick={runBackup} disabled={busy === "backup"}>
              Create Backup (xlsx + zip)
            </button>
          </div>
          {backupInfo && (
            <div className="stack">
              <div className="mono">xlsx: {backupInfo.xlsxPath}</div>
              <div className="mono">zip: {backupInfo.zipPath}</div>
            </div>
          )}
        </div>

        <div className="card">
          <h2>Players</h2>
          <div className="row">
            <input
              type="text"
              placeholder="player_id"
              value={playerForm.playerId}
              onChange={(e) => setPlayerField("playerId", e.target.value)}
            />
            <button onClick={loadPlayer} disabled={busy === "player"}>
              Load
            </button>
            <button onClick={savePlayer} disabled={busy === "player"}>
              Save
            </button>
          </div>
          <div className="row">
            <input
              type="text"
              placeholder="name"
              value={playerForm.name}
              onChange={(e) => setPlayerField("name", e.target.value)}
            />
          </div>
          <div className="row">
            <input
              type="text"
              placeholder="power_current"
              value={playerForm.power}
              onChange={(e) => setPlayerField("power", e.target.value)}
            />
            <input
              type="text"
              placeholder="kp_current"
              value={playerForm.kp}
              onChange={(e) => setPlayerField("kp", e.target.value)}
            />
            <input
              type="text"
              placeholder="dead_current"
              value={playerForm.dead}
              onChange={(e) => setPlayerField("dead", e.target.value)}
            />
          </div>
          <div className="row">
            <input
              type="text"
              placeholder="t4_kills_current"
              value={playerForm.t4}
              onChange={(e) => setPlayerField("t4", e.target.value)}
            />
            <input
              type="text"
              placeholder="t5_kills_current"
              value={playerForm.t5}
              onChange={(e) => setPlayerField("t5", e.target.value)}
            />
          </div>
          <div className="row">
            <input
              type="text"
              placeholder="last_update (ISO, optional)"
              value={playerForm.lastUpdate}
              onChange={(e) => setPlayerField("lastUpdate", e.target.value)}
            />
            <button
              onClick={() => setPlayerField("lastUpdate", new Date().toISOString())}
              disabled={busy === "player"}
            >
              Now
            </button>
          </div>
          {playerStatus ? <p className="muted">{playerStatus}</p> : null}
        </div>

        <div className="card">
          <h2>DB</h2>
          <div className="row">
            <button onClick={clearImports} disabled={busy === "db"}>
              Clear Imports
            </button>
          </div>
          <div className="stack">
            {Object.keys(dbCounts).length === 0 ? (
              <div className="muted">No stats loaded.</div>
            ) : (
              Object.entries(dbCounts).map(([k, v]) => (
                <div key={k} className="row between">
                  <span>{k}</span>
                  <span className="mono">{v}</span>
                </div>
              ))
            )}
            <div className="row between">
              <span>last_import_ts</span>
              <span className="mono">{lastImportTs || "-"}</span>
            </div>
            <div className="row between">
              <span>last_player_update</span>
              <span className="mono">{lastPlayerUpdateTs || "-"}</span>
            </div>
          </div>
        </div>

        <div className="card">
          <h2>Role Switch</h2>
          <div className="row">
            <input
              type="text"
              placeholder="player_id"
              value={rolePlayerId}
              onChange={(e) => setRolePlayerId(e.target.value)}
            />
            <input
              type="text"
              placeholder="owner_id (for farm)"
              value={roleOwnerId}
              onChange={(e) => setRoleOwnerId(e.target.value)}
            />
          </div>
          <div className="row">
            <button onClick={() => setRole("farm")} disabled={busy === "role"}>
              Set Farm
            </button>
            <button onClick={() => setRole("main")} disabled={busy === "role"}>
              Set Main
            </button>
          </div>
          <div className="muted">Farm requires owner_id; main removes any farm link.</div>
        </div>

        <div className="card">
          <h2>Danger Zone</h2>
          <div className="row">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={resetClearGoals}
                onChange={(e) => setResetClearGoals(e.target.checked)}
              />
              Clear goals
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={resetClearImports}
                onChange={(e) => setResetClearImports(e.target.checked)}
              />
              Clear imports
            </label>
          </div>
          <div className="row">
            <input
              type="text"
              placeholder='Type "RESET" to confirm'
              value={resetConfirm}
              onChange={(e) => setResetConfirm(e.target.value)}
            />
            <button onClick={resetKvK} disabled={busy === "reset"}>
              Reset Active KvK
            </button>
          </div>
          <div className="row">
            <input
              type="text"
              placeholder='Type "WIPE" to confirm'
              value={wipeConfirm}
              onChange={(e) => setWipeConfirm(e.target.value)}
            />
            <button onClick={wipeDb} disabled={busy === "wipe"}>
              Wipe DB
            </button>
          </div>
          <div className="muted">
            Reset closes current KvK and deletes selected data. Wipe drops all bot tables.
          </div>
        </div>
      </section>

      {statusMsg && <div className="status">{statusMsg}</div>}
    </div>
  );
}
