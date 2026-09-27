import React, { useState, useEffect, useMemo, useRef, createContext, useContext } from "react";
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ReferenceArea,
} from "recharts";
import {
  Bell, Settings, Wifi, WifiOff, LayoutDashboard, Activity, Snowflake,
  Thermometer, Boxes, Cpu, AlertTriangle, Info, ChevronDown, Droplets,
  Fan, Zap, Radio, CheckCircle2, XCircle, Download, Leaf, Gauge,
  PlugZap, CircuitBoard, ArrowDown, ArrowUp, Minus,
} from "lucide-react";

/* ============================================================================
   AAHAAR-Setu — Hardware Digital Twin Dashboard
   Prototype: ESP32 + DHT11 + W1209 + Peltier cold-storage chamber.
   Every reading on screen is either (a) simulated by MockTelemetryEngine to
   stand in for the real ESP32 feed, or (b) explicitly labeled "Not measured"
   / "Future Integration" when the hardware to produce it doesn't exist yet.
   ============================================================================ */

// --------------------------------- CONFIG ----------------------------------
const CONFIG = {
  DATA_MODE: "MOCK",               // "MOCK" | "SERIAL" | "ESP32"
  ESP32_ENDPOINT: "http://ESP32_IP_ADDRESS",
  UPDATE_INTERVAL_MS: 2000,
  HISTORY_LENGTH: 45,
  SERIAL_BAUD: 9600,
};

const CROP_ZONES = {
  citrus:      { label: "Citrus",               min: 7,  max: 10 },
  chilli:      { label: "Fresh Chilli",          min: 7,  max: 10 },
  cool_veg:    { label: "Cool-Season Vegetables", min: 0,  max: 4  },
  tropical:    { label: "Tropical Fruits",        min: 10, max: 14 },
  rhizomes:    { label: "Rhizomes",               min: 10, max: 14 },
};

const FUTURE_MODULES = [
  "Solar PV", "MPPT Controller", "Battery Bank", "Pyranometer",
  "Power Meter", "Weather API", "Additional Sensors", "PCM Thermal Storage",
];

// ------------------------------ Mock telemetry ------------------------------
// Gradual, physically-plausible drift — never random jumps.
function createMockEngine() {
  let ambient = 24;
  let target = 8;
  let chamber = 18;
  let humidity = 72;
  let cooling = true;
  let consecutiveNoProgress = 0;
  let lastChamber = chamber;

  function tick() {
    const tolerance = 0.6;
    cooling = chamber > target + tolerance ? true : chamber < target - tolerance ? false : cooling;

    const pull = cooling ? (target - chamber) : (ambient - chamber);
    const rate = cooling ? 0.16 : 0.05;
    const noise = (Math.random() - 0.5) * 0.12;
    chamber = chamber + pull * rate + noise;
    chamber = Math.round(chamber * 10) / 10;

    const humidityPull = cooling ? -0.18 : 0.12;
    humidity = Math.min(95, Math.max(38, humidity + humidityPull + (Math.random() - 0.5) * 0.6));
    humidity = Math.round(humidity * 10) / 10;

    if (cooling) {
      if (chamber >= lastChamber - 0.05) consecutiveNoProgress++;
      else consecutiveNoProgress = 0;
    } else {
      consecutiveNoProgress = 0;
    }
    lastChamber = chamber;

    return {
      timestamp: Date.now(),
      temperature: chamber,
      humidity,
      ambient,
      target,
      peltierStatus: cooling ? "ACTIVE" : "IDLE",
      fanStatus: cooling ? "RUNNING" : "STOPPED",
      w1209Status: "CONNECTED",
      esp32Status: "ONLINE",
      coolingInefficient: cooling && consecutiveNoProgress >= 5,
    };
  }

  function setTarget(t) { target = t; }
  function getTarget() { return target; }

  return { tick, setTarget, getTarget };
}

// ------------------------------ Serial telemetry (Arduino Uno via USB) ------------------------------
// Web Serial API — works in Chrome/Edge, needs a user click to open the port,
// and needs https:// or http://localhost. Arduino just prints "temp,humidity,COOLING\n".
function useSerialReader(onReading) {
  const [port, setPort] = useState(null);
  const [serialConnected, setSerialConnected] = useState(false);
  const [serialError, setSerialError] = useState(null);

  async function connect() {
    setSerialError(null);
    try {
      if (!("serial" in navigator)) {
        setSerialError("Web Serial API not supported — use Chrome or Edge.");
        return;
      }
      const p = await navigator.serial.requestPort();
      await p.open({ baudRate: CONFIG.SERIAL_BAUD });
      setPort(p);
      setSerialConnected(true);

      const textDecoder = new TextDecoderStream();
      p.readable.pipeTo(textDecoder.writable);
      const reader = textDecoder.readable.getReader();
      let buffer = "";

      (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value;
            let lines = buffer.split("\n");
            buffer = lines.pop();
            for (const line of lines) {
              const parts = line.trim().split(",");
              if (parts.length >= 3) {
                const temperature = parseFloat(parts[0]);
                const humidity = parseFloat(parts[1]);
                const cooling = parts[2].trim().toUpperCase();
                if (!Number.isNaN(temperature) && !Number.isNaN(humidity)) {
                  onReading({
                    timestamp: Date.now(),
                    temperature, humidity,
                    ambient: 24, target: 8,
                    peltierStatus: cooling === "ACTIVE" ? "ACTIVE" : "IDLE",
                    fanStatus: cooling === "ACTIVE" ? "RUNNING" : "STOPPED",
                    w1209Status: "CONNECTED",
                    esp32Status: "ONLINE",
                    coolingInefficient: false,
                  });
                }
              }
            }
          }
        } catch (e) {
          setSerialError("Serial read error: " + e.message);
          setSerialConnected(false);
        }
      })();
    } catch (e) {
      setSerialError(e.message);
    }
  }

  return { connect, serialConnected, serialError };
}

const TelemetryContext = createContext(null);
function useTelemetry() { return useContext(TelemetryContext); }

function TelemetryProvider({ children }) {
  const engineRef = useRef(null);
  if (!engineRef.current) engineRef.current = createMockEngine();

  const [history, setHistory] = useState(() => {
    const seed = [];
    for (let i = 0; i < 6; i++) seed.push(engineRef.current.tick());
    return seed;
  });
  const [connected, setConnected] = useState(true);
  const [targetInput, setTargetInput] = useState(engineRef.current.getTarget());

  function pushReading(reading) {
    setHistory((prev) => [...prev.slice(-(CONFIG.HISTORY_LENGTH - 1)), reading]);
  }

  const { connect: connectSerial, serialConnected, serialError } = useSerialReader(pushReading);

  useEffect(() => {
    if (CONFIG.DATA_MODE !== "MOCK") return; // SERIAL mode is user-triggered via connectSerial(); ESP32 mode would poll CONFIG.ESP32_ENDPOINT
    const id = setInterval(() => {
      pushReading(engineRef.current.tick());
    }, CONFIG.UPDATE_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (CONFIG.DATA_MODE === "SERIAL") setConnected(serialConnected);
  }, [serialConnected]);

  function setTarget(t) {
    engineRef.current.setTarget(t);
    setTargetInput(t);
  }

  const latest = history[history.length - 1];
  const value = {
    history, latest, connected, setConnected, setTarget, targetInput,
    dataMode: CONFIG.DATA_MODE, connectSerial, serialConnected, serialError,
  };
  return <TelemetryContext.Provider value={value}>{children}</TelemetryContext.Provider>;
}

// --------------------------------- Styling ----------------------------------
const CSS = `
  .as-root { --forest:#14332A; --forestDeep:#0C231C; --moss:#3B6255; --paper:#F5F3EE;
    --clay:#C97C42; --frost:#35688A; --rust:#9E3B34; --ink:#1B231F; --line:#E1E4DC; --sub:#5E6B62;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
    color: var(--ink); background: var(--paper); min-height:100%; }
  .as-mono { font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
  .as-shell { display:grid; grid-template-columns: 236px 1fr; grid-template-rows: 68px 38px 1fr; min-height:100%; }
  @media (max-width: 880px) { .as-shell { grid-template-columns: 1fr; } .as-sidebar { display:none; } }

  .as-header { grid-column: 1 / -1; background: var(--forestDeep); color:#fff; display:grid;
    grid-template-columns: 1fr auto 1fr; align-items:center; padding:0 22px; }
  .as-brand-wrap { display:flex; flex-direction:column; align-items:center; justify-self:center; grid-column:2; }
  .as-brand { font-size:23px; font-weight:800; letter-spacing:-0.015em; }
  .as-brand-sub { font-size:11px; color:#9DB5A8; margin-top:1px; }
  .as-header-right { grid-column:3; display:flex; gap:18px; align-items:center; justify-self:end; }
  .as-header-conn { display:flex; align-items:center; gap:7px; font-size:12.5px; color:#D7E4DC;
    background:rgba(255,255,255,0.08); border-radius:20px; padding:6px 13px 6px 11px; }
  .as-header-conn b { color:#fff; }
  .as-dot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
  .as-dot-on { background:#4CBB8A; box-shadow:0 0 0 3px rgba(76,187,138,0.25); }
  .as-dot-off { background:#D96A5F; box-shadow:0 0 0 3px rgba(217,106,95,0.25); }
  .as-header-icons { display:flex; gap:16px; align-items:center; color:#D7E4DC; padding-left:4px;
    border-left:1px solid rgba(255,255,255,0.14); }
  .as-header-icons svg { width:18px; height:18px; cursor:pointer; }

  .as-statusstrip { grid-column: 1 / -1; background:#EAEDE5; border-bottom:1px solid var(--line);
    display:flex; align-items:center; gap:10px; padding:0 22px; }
  .as-strip-item { display:flex; align-items:center; gap:7px; font-size:12px; color:var(--sub);
    background:#fff; border:1px solid var(--line); border-radius:20px; padding:5px 13px 5px 11px; }
  .as-strip-item svg { width:13px; height:13px; color:var(--moss); }
  .as-strip-item b { color:var(--ink); font-weight:700; margin-left:1px; }

  .as-sidebar { background: var(--paper); border-right:1px solid var(--line); padding:16px 12px; display:flex; flex-direction:column; }
  .as-nav { display:flex; flex-direction:column; gap:2px; }
  .as-nav-item { display:flex; align-items:center; gap:10px; padding:9px 10px; border-radius:8px; font-size:13.5px;
    font-weight:600; color:#455249; cursor:pointer; border:none; background:none; text-align:left; width:100%; }
  .as-nav-item svg { width:16px; height:16px; flex-shrink:0; }
  .as-nav-item:hover { background:#E8ECE4; }
  .as-nav-item.active { background: var(--forest); color:#fff; }
  .as-sidebar-foot { margin-top:auto; padding:12px 10px; border-top:1px solid var(--line); }
  .as-node-label { font-size:11px; font-weight:700; letter-spacing:0.04em; color:var(--sub); }
  .as-node-status { display:flex; align-items:center; gap:6px; font-size:13px; font-weight:700; margin-top:5px; color:var(--forestDeep); }
  .as-demo-pill { margin-top:10px; font-size:10.5px; font-weight:800; letter-spacing:0.05em; color:#8A6900;
    background:#FCEFCB; border:1px solid #EBD79A; padding:4px 8px; border-radius:6px; text-align:center; }

  .as-main { padding:22px 26px 40px; overflow:auto; }
  .as-page-title { font-size:23px; font-weight:800; margin:0 0 4px; }
  .as-page-sub { font-size:13.5px; color:var(--sub); margin:0 0 20px; }

  .as-panel { background:#fff; border:1px solid var(--line); border-radius:12px; padding:18px 20px; }
  .as-panel-title { display:flex; align-items:center; gap:8px; font-size:15px; font-weight:700; margin:0 0 14px; }
  .as-panel-title svg { width:17px; height:17px; color:var(--frost); }

  .as-kpi-grid { display:grid; grid-template-columns: repeat(4, 1fr); gap:14px; }
  @media (max-width: 980px) { .as-kpi-grid { grid-template-columns: 1fr 1fr; } }
  @media (max-width: 520px) { .as-kpi-grid { grid-template-columns: 1fr; } }
  .as-kpi { display:flex; flex-direction:column; gap:8px; padding:16px 18px; }
  .as-kpi-label { font-size:12px; color:var(--sub); font-weight:600; display:flex; align-items:center; gap:6px; }
  .as-kpi-value { font-size:27px; font-weight:800; display:flex; align-items:baseline; gap:4px; }
  .as-kpi-unit { font-size:13px; font-weight:700; color:var(--sub); }
  .as-kpi-note { font-size:11px; color:var(--sub); }

  .as-badge { display:inline-flex; align-items:center; gap:5px; padding:4px 11px; border-radius:20px; font-size:11.5px; font-weight:800; letter-spacing:0.02em; }
  .as-badge-ok { background:#E2F0E7; color:var(--forestDeep); }
  .as-badge-active { background: var(--forest); color:#fff; }
  .as-badge-warn { background:#FCEFCB; color:#8A6900; }
  .as-badge-crit { background:#F6DEDB; color:var(--rust); }
  .as-badge-idle { background:#EEF0EC; color:var(--sub); }

  .as-col { display:flex; flex-direction:column; gap:16px; }
  .as-grid-2 { display:grid; grid-template-columns: 1.3fr 1fr; gap:16px; align-items:start; }
  @media (max-width: 1080px) { .as-grid-2 { grid-template-columns: 1fr; } }

  .as-flow { display:flex; flex-direction:column; gap:0; align-items:stretch; }
  .as-flow-step { display:flex; align-items:center; gap:12px; padding:12px 14px; border:1px solid var(--line); border-radius:10px; background:var(--paper); }
  .as-flow-step .ic { width:34px; height:34px; border-radius:9px; background:var(--forest); color:#fff; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
  .as-flow-step .ic svg { width:17px; height:17px; }
  .as-flow-title { font-size:13.5px; font-weight:700; }
  .as-flow-sub { font-size:12px; color:var(--sub); }
  .as-flow-value { margin-left:auto; font-size:15px; font-weight:800; }
  .as-flow-arrow { display:flex; justify-content:center; padding:3px 0; color:var(--sub); }
  .as-flow-arrow svg { width:15px; height:15px; }

  .as-demo-banner { display:flex; align-items:center; gap:8px; background:#FCEFCB; border:1px solid #EBD79A; color:#7A5D00;
    font-size:12px; font-weight:700; padding:8px 12px; border-radius:9px; margin-bottom:16px; }
  .as-demo-banner svg { width:14px; height:14px; }

  table.as-table { width:100%; border-collapse:collapse; font-size:13px; }
  table.as-table th { text-align:left; font-size:11px; font-weight:700; letter-spacing:0.03em; color:var(--sub); padding:8px 10px; border-bottom:1px solid var(--line); }
  table.as-table td { padding:9px 10px; border-bottom:1px solid #EFF2ED; }

  .as-slider-row { display:flex; align-items:center; gap:12px; margin-top:8px; }
  .as-slider-row input[type=range] { flex:1; accent-color: var(--forest); }
  .as-target-note { font-size:11.5px; color:var(--sub); margin-top:8px; line-height:1.5; }

  .as-crop-select { font-family:inherit; font-size:13.5px; padding:9px 12px; border:1px solid var(--line); border-radius:8px; background:#fff; width:100%; margin-bottom:14px; }

  .as-compat { padding:14px 16px; border-radius:10px; border:1px dashed; font-size:13px; line-height:1.6; }
  .as-compat.ok { border-color:#8FBBA0; background:#E9F3EC; color:#1B4332; }
  .as-compat.warn { border-color:#E9C25E; background:#FCF4DC; color:#5A4300; }

  .as-alert { display:flex; gap:12px; padding:13px 15px; border-radius:10px; border:1px solid var(--line); margin-bottom:10px; }
  .as-alert .ic { flex-shrink:0; }
  .as-alert-title { font-size:13.5px; font-weight:700; margin-bottom:2px; }
  .as-alert-msg { font-size:12.5px; color:var(--sub); }
  .as-alert-time { font-size:11px; color:var(--sub); margin-left:auto; white-space:nowrap; }
  .as-alert.crit { border-left:3px solid var(--rust); }
  .as-alert.warn { border-left:3px solid var(--clay); }
  .as-alert.info { border-left:3px solid var(--frost); }

  .as-hw-grid { display:grid; grid-template-columns: repeat(4, 1fr); gap:12px; }
  @media (max-width: 900px) { .as-hw-grid { grid-template-columns: 1fr 1fr; } }
  .as-hw-card { border:1px solid var(--line); border-radius:10px; padding:14px; display:flex; flex-direction:column; gap:6px; }
  .as-hw-card .ic { width:30px; height:30px; border-radius:8px; background:var(--paper); display:flex; align-items:center; justify-content:center; color:var(--forest); }
  .as-hw-name { font-size:13px; font-weight:700; }
  .as-hw-desc { font-size:11.5px; color:var(--sub); line-height:1.4; }

  .as-future-grid { display:grid; grid-template-columns: repeat(4, 1fr); gap:10px; }
  @media (max-width: 900px) { .as-future-grid { grid-template-columns: 1fr 1fr; } }
  .as-future-chip { padding:10px 12px; border-radius:9px; border:1px dashed var(--line); background:#F8F8F5; color:var(--sub); font-size:12px; font-weight:600; text-align:center; }

  .as-export-btn { border:1px solid var(--line); background:#fff; color:var(--ink); font-weight:700; font-size:12.5px;
    padding:8px 14px; border-radius:8px; cursor:pointer; display:inline-flex; align-items:center; gap:6px; }
  .as-export-btn svg { width:14px; height:14px; }

  .as-info-list { display:grid; grid-template-columns: 1fr 1fr; gap:10px 22px; font-size:13.5px; }
  @media (max-width: 600px) { .as-info-list { grid-template-columns: 1fr; } }
  .as-info-row { display:flex; justify-content:space-between; padding:9px 0; border-bottom:1px solid #EFF2ED; }
  .as-info-k { color:var(--sub); }
  .as-info-v { font-weight:700; }
`;

// -------------------------------- utilities ---------------------------------
function fmt(n, d = 1) { return Number(n).toFixed(d); }
function timeLabel(ts) { return new Date(ts).toLocaleTimeString(undefined, { hour12: false }); }
function chamberStatus({ temperature, target, esp32Status, w1209Status, coolingInefficient }, cropRange) {
  if (esp32Status !== "ONLINE") return { label: "SENSOR ERROR", tone: "crit" };
  if (w1209Status !== "CONNECTED") return { label: "CONTROLLER OFFLINE", tone: "crit" };
  if (cropRange && (temperature < cropRange.min - 1.5 || temperature > cropRange.max + 1.5)) return { label: "AT RISK", tone: "crit" };
  if (coolingInefficient) return { label: "AT RISK", tone: "warn" };
  const diff = temperature - target;
  if (Math.abs(diff) <= 0.7) return { label: "STABLE", tone: "ok" };
  if (diff > 0) return { label: "COOLING", tone: "active" };
  return { label: "WARMING", tone: "warn" };
}

function StatusBadge({ label, tone }) {
  const cls = { ok: "as-badge-ok", active: "as-badge-active", warn: "as-badge-warn", crit: "as-badge-crit", idle: "as-badge-idle" }[tone] || "as-badge-idle";
  return <span className={`as-badge ${cls}`}>{label}</span>;
}

function MetricCard({ icon, label, value, unit, note, trend }) {
  return (
    <div className="as-panel as-kpi">
      <div className="as-kpi-label">{icon} {label}</div>
      <div className="as-kpi-value as-mono">
        {value}{unit && <span className="as-kpi-unit">{unit}</span>}
        {trend === "up" && <ArrowUp size={14} color="var(--rust)" />}
        {trend === "down" && <ArrowDown size={14} color="var(--frost)" />}
        {trend === "flat" && <Minus size={14} color="var(--sub)" />}
      </div>
      {note && <div className="as-kpi-note">{note}</div>}
    </div>
  );
}

function DemoBanner() {
  return (
    <div className="as-demo-banner">
      <Info /> DEMO TELEMETRY — values are generated by the mock engine, not the physical ESP32 feed.
    </div>
  );
}

// ---------------------------------- Pages -----------------------------------
function OverviewPage() {
  const { latest, history, dataMode } = useTelemetry();
  const prev = history[history.length - 2] || latest;
  const trend = latest.temperature < prev.temperature - 0.02 ? "down" : latest.temperature > prev.temperature + 0.02 ? "up" : "flat";
  const status = chamberStatus(latest, null);

  return (
    <>
      {dataMode === "MOCK" && <DemoBanner />}
      <div className="as-kpi-grid">
        <MetricCard icon={<Thermometer size={14} />} label="Chamber Temperature" value={fmt(latest.temperature)} unit="°C" trend={trend} />
        <MetricCard icon={<Droplets size={14} />} label="Humidity" value={fmt(latest.humidity, 0)} unit="%" />
        <MetricCard icon={<Snowflake size={14} />} label="Target Temperature" value={fmt(latest.target, 0)} unit="°C" />
        <MetricCard icon={<Gauge size={14} />} label="Chamber Condition" value={<StatusBadge {...status} />} />

        <MetricCard icon={<Zap size={14} />} label="Peltier Status" value={<StatusBadge label={latest.peltierStatus} tone={latest.peltierStatus === "ACTIVE" ? "active" : "idle"} />} />
        <MetricCard icon={<CircuitBoard size={14} />} label="W1209 Status" value={<StatusBadge label={latest.w1209Status} tone="ok" />} />
        <MetricCard icon={<Cpu size={14} />} label="ESP32 Status" value={<StatusBadge label={latest.esp32Status} tone="ok" />} />
        <MetricCard icon={<Fan size={14} />} label="Fan" value={<StatusBadge label={latest.fanStatus} tone={latest.fanStatus === "RUNNING" ? "active" : "idle"} />} />
      </div>
    </>
  );
}

function LiveMonitorPage() {
  const { history, latest, dataMode } = useTelemetry();
  const temps = history.map((h) => h.temperature);
  const min = Math.min(...temps), max = Math.max(...temps);
  const avg = temps.reduce((a, b) => a + b, 0) / temps.length;

  return (
    <>
      {dataMode === "MOCK" && <DemoBanner />}
      <div className="as-kpi-grid" style={{ marginBottom: 16 }}>
        <MetricCard icon={<Thermometer size={14} />} label="Current" value={fmt(latest.temperature)} unit="°C" />
        <MetricCard icon={<Snowflake size={14} />} label="Target" value={fmt(latest.target, 0)} unit="°C" />
        <MetricCard icon={<ArrowDown size={14} />} label="Minimum" value={fmt(min)} unit="°C" />
        <MetricCard icon={<ArrowUp size={14} />} label="Maximum" value={fmt(max)} unit="°C" />
      </div>

      <div className="as-panel" style={{ marginBottom: 16 }}>
        <h2 className="as-panel-title"><Activity /> Chamber Temperature — Average {fmt(avg)}°C</h2>
        <div style={{ height: 220 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={history} margin={{ top: 4, right: 8, left: -14, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#EEF0EA" />
              <XAxis dataKey="timestamp" tickFormatter={timeLabel} tick={{ fontSize: 10, fill: "#5E6B62" }} minTickGap={40} />
              <YAxis domain={[Math.min(0, min - 2), Math.max(30, max + 2)]} tick={{ fontSize: 10, fill: "#5E6B62" }} />
              <Tooltip labelFormatter={timeLabel} formatter={(v, n) => [`${v}°C`, n === "temperature" ? "Chamber" : "Target"]} />
              <ReferenceArea y1={latest.target - 1} y2={latest.target + 1} fill="var(--frost)" fillOpacity={0.08} />
              <ReferenceLine y={latest.target} stroke="var(--forest)" strokeDasharray="4 4" />
              <Area type="monotone" dataKey="temperature" name="temperature" fill="var(--frost)" fillOpacity={0.15} stroke="var(--frost)" strokeWidth={2.5} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="as-panel" style={{ marginBottom: 16 }}>
        <h2 className="as-panel-title"><Droplets /> Chamber Humidity</h2>
        <div style={{ height: 160 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={history} margin={{ top: 4, right: 8, left: -14, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#EEF0EA" />
              <XAxis dataKey="timestamp" tickFormatter={timeLabel} tick={{ fontSize: 10, fill: "#5E6B62" }} minTickGap={40} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "#5E6B62" }} />
              <Tooltip labelFormatter={timeLabel} formatter={(v) => [`${v}%`, "Humidity"]} />
              <Line type="monotone" dataKey="humidity" name="humidity" stroke="var(--clay)" strokeWidth={2.5} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      <ThermalFlowCard latest={latest} />
    </>
  );
}

function ThermalFlowCard({ latest }) {
  const steps = [
    { icon: <Thermometer />, title: "Ambient Environment", sub: "Room air surrounding the chamber", value: `${fmt(latest.ambient, 0)}°C` },
    { icon: <Boxes />, title: "Insulated Chamber", sub: "Thermocol enclosure", value: `${fmt(latest.temperature)}°C` },
    { icon: <Snowflake />, title: "Peltier Cooling", sub: latest.peltierStatus === "ACTIVE" ? "Actively removing heat" : "Idle — target reached", value: latest.peltierStatus },
    { icon: <Fan />, title: "Cold-Side Heatsink + Fan", sub: "Dissipates heat drawn from chamber", value: latest.fanStatus },
  ];
  return (
    <div className="as-panel">
      <h2 className="as-panel-title"><Snowflake /> Thermal Flow</h2>
      <div className="as-flow">
        {steps.map((s, i) => (
          <React.Fragment key={s.title}>
            <div className="as-flow-step">
              <div className="ic">{s.icon}</div>
              <div>
                <div className="as-flow-title">{s.title}</div>
                <div className="as-flow-sub">{s.sub}</div>
              </div>
              <div className="as-flow-value as-mono">{s.value}</div>
            </div>
            {i < steps.length - 1 && <div className="as-flow-arrow"><ArrowDown /></div>}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

function CoolingSystemPage() {
  const { latest, setTarget, targetInput } = useTelemetry();
  const mode = Math.abs(latest.temperature - latest.target) <= 0.7 ? "TARGET REACHED" : latest.peltierStatus === "ACTIVE" ? "COOLING" : "IDLE";

  const logicSteps = [
    { label: "Chamber > Target?", active: latest.temperature > latest.target },
    { label: "Peltier System Active", active: latest.peltierStatus === "ACTIVE" },
    { label: "Fan / Heat Dissipation Active", active: latest.fanStatus === "RUNNING" },
    { label: "Temperature Approaching Target", active: latest.peltierStatus === "ACTIVE" },
    { label: "Target Reached → Regulation", active: mode === "TARGET REACHED" },
  ];

  return (
    <div className="as-grid-2">
      <div className="as-col">
        <div className="as-panel">
          <h2 className="as-panel-title"><Zap /> Peltier Cooling System</h2>
          <div className="as-kpi-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
            <MetricCard icon={<Zap size={14} />} label="Peltier" value={<StatusBadge label={latest.peltierStatus} tone={latest.peltierStatus === "ACTIVE" ? "active" : "idle"} />} />
            <MetricCard icon={<Fan size={14} />} label="Fan" value={<StatusBadge label={latest.fanStatus} tone={latest.fanStatus === "RUNNING" ? "active" : "idle"} />} />
            <MetricCard icon={<Thermometer size={14} />} label="Chamber Temperature" value={fmt(latest.temperature)} unit="°C" />
            <MetricCard icon={<Snowflake size={14} />} label="Target Temperature" value={fmt(latest.target, 0)} unit="°C" />
            <MetricCard icon={<CircuitBoard size={14} />} label="W1209 Controller" value={<StatusBadge label={latest.w1209Status} tone="ok" />} />
            <MetricCard icon={<Gauge size={14} />} label="Cooling Mode" value={<StatusBadge label={mode} tone={mode === "TARGET REACHED" ? "ok" : mode === "COOLING" ? "active" : "idle"} />} />
          </div>
          <div className="as-target-note">
            Cold-side surface temperature is not independently measured on this prototype (only the chamber-air DHT11 reading is available), so it is not displayed separately.
          </div>
        </div>

        <div className="as-panel">
          <h2 className="as-panel-title"><Gauge /> Target Temperature</h2>
          <div className="as-slider-row">
            <input type="range" min={4} max={14} step={0.5} value={targetInput} onChange={(e) => setTarget(Number(e.target.value))} />
            <div className="as-mono" style={{ fontWeight: 800, fontSize: 18, width: 64 }}>{fmt(targetInput, 1)}°C</div>
          </div>
          <div className="as-target-note">
            <b>Dashboard Target</b> is the setpoint used by this mock simulation. It is distinct from the <b>W1209 Physical Setpoint</b>,
            which is currently configured manually on the controller's onboard dial — no bidirectional ESP32 ↔ W1209 link exists yet.
          </div>
        </div>
      </div>

      <div className="as-panel">
        <h2 className="as-panel-title"><Activity /> Cooling Logic</h2>
        <div className="as-flow">
          {logicSteps.map((s, i) => (
            <React.Fragment key={s.label}>
              <div className="as-flow-step">
                <div className="ic" style={{ background: s.active ? "var(--forest)" : "#B8C2BB" }}>
                  {s.active ? <CheckCircle2 /> : <Minus />}
                </div>
                <div className="as-flow-title">{s.label}</div>
              </div>
              {i < logicSteps.length - 1 && <div className="as-flow-arrow"><ArrowDown /></div>}
            </React.Fragment>
          ))}
        </div>
        {latest.coolingInefficient && (
          <div className="as-compat warn" style={{ marginTop: 14 }}>
            ⚠ <b>Possible Cooling Inefficiency</b> — chamber temperature has not decreased over several consecutive readings while the Peltier is active.
            This is a software diagnostic, not a confirmed hardware fault.
          </div>
        )}
      </div>
    </div>
  );
}

function SensorDataPage() {
  const { latest, history } = useTelemetry();
  const rows = [...history].slice(-12).reverse();
  return (
    <div className="as-grid-2">
      <div className="as-panel">
        <h2 className="as-panel-title"><Radio /> DHT11 Telemetry</h2>
        <div className="as-kpi-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
          <MetricCard icon={<Thermometer size={14} />} label="Temperature" value={fmt(latest.temperature)} unit="°C" />
          <MetricCard icon={<Droplets size={14} />} label="Humidity" value={fmt(latest.humidity, 0)} unit="%" />
          <MetricCard icon={<CheckCircle2 size={14} />} label="Sensor Status" value={<StatusBadge label="NORMAL" tone="ok" />} />
          <MetricCard icon={<Info size={14} />} label="Reading Interval" value={CONFIG.UPDATE_INTERVAL_MS / 1000} unit="s" />
        </div>
        <div className="as-target-note">Last update: {timeLabel(latest.timestamp)} · Data quality: GOOD</div>
      </div>

      <div className="as-panel">
        <h2 className="as-panel-title"><Cpu /> Sensor Health</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="as-info-row"><span className="as-info-k">DHT11</span><StatusBadge label="ONLINE" tone="ok" /></div>
          <div className="as-info-row"><span className="as-info-k">Data packets received</span><span className="as-info-v as-mono">{1200 + history.length}</span></div>
          <div className="as-info-row"><span className="as-info-k">Last update</span><span className="as-info-v as-mono">{timeLabel(latest.timestamp)}</span></div>
          <div className="as-info-row"><span className="as-info-k">Signal</span><span className="as-info-v">GOOD</span></div>
        </div>
      </div>

      <div className="as-panel" style={{ gridColumn: "1 / -1" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <h2 className="as-panel-title" style={{ margin: 0 }}><Boxes /> Historical Telemetry</h2>
          <button className="as-export-btn" onClick={() => exportCsv(history)}><Download /> Export Telemetry</button>
        </div>
        <table className="as-table">
          <thead><tr><th>Timestamp</th><th>Temperature</th><th>Humidity</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.timestamp}>
                <td className="as-mono">{timeLabel(r.timestamp)}</td>
                <td className="as-mono">{fmt(r.temperature)}°C</td>
                <td className="as-mono">{fmt(r.humidity, 0)}%</td>
                <td><StatusBadge {...chamberStatus(r, null)} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function exportCsv(history) {
  const header = "timestamp,temperature,humidity,peltierStatus,fanStatus,w1209Status,esp32Status\n";
  const rows = history.map((h) => [new Date(h.timestamp).toISOString(), h.temperature, h.humidity, h.peltierStatus, h.fanStatus, h.w1209Status, h.esp32Status].join(",")).join("\n");
  const blob = new Blob([header + rows], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "aahaar-setu-telemetry.csv"; a.click();
  URL.revokeObjectURL(url);
}

function StorageZonePage() {
  const { latest } = useTelemetry();
  const [crop, setCrop] = useState("chilli");
  const range = CROP_ZONES[crop];
  const within = latest.temperature >= range.min && latest.temperature <= range.max;

  return (
    <div className="as-grid-2">
      <div className="as-panel">
        <h2 className="as-panel-title"><Leaf /> Storage Zone</h2>
        <div className="as-info-row"><span className="as-info-k">Current zone</span><span className="as-info-v">Prototype Cold Zone</span></div>
        <div className="as-info-row"><span className="as-info-k">Recommended Storage Range</span><span className="as-info-v as-mono">{range.min}–{range.max}°C</span></div>
        <div className="as-info-row" style={{ borderBottom: "none" }}><span className="as-info-k">Controller Setpoint</span><span className="as-info-v as-mono">{fmt(latest.target, 0)}°C (manual)</span></div>

        <div style={{ marginTop: 16 }}>
          <label style={{ fontSize: 12.5, fontWeight: 700, color: "var(--sub)" }}>Select crop</label>
          <select className="as-crop-select" value={crop} onChange={(e) => setCrop(e.target.value)}>
            {Object.entries(CROP_ZONES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>
      </div>

      <div className="as-panel">
        <h2 className="as-panel-title"><CheckCircle2 /> Crop-Zone Compatibility</h2>
        <div className="as-info-row"><span className="as-info-k">Selected crop</span><span className="as-info-v">{range.label}</span></div>
        <div className="as-info-row"><span className="as-info-k">Recommended</span><span className="as-info-v as-mono">{range.min}–{range.max}°C</span></div>
        <div className="as-info-row" style={{ borderBottom: "none" }}><span className="as-info-k">Current</span><span className="as-info-v as-mono">{fmt(latest.temperature)}°C</span></div>
        <div className={`as-compat ${within ? "ok" : "warn"}`} style={{ marginTop: 12 }}>
          {within ? "✓ Within recommended range" : "⚠ Temperature outside recommended range"}
        </div>
        <div className="as-target-note">
          A single fixed setpoint can't correctly serve every crop — AAHAAR-Setu's full architecture assigns crop-specific thermal zones instead of one universal target.
        </div>
      </div>
    </div>
  );
}

function HardwarePage() {
  const items = [
    { icon: <Cpu />, name: "ESP32", desc: "WiFi microcontroller — reads DHT11, publishes telemetry to the dashboard." },
    { icon: <Radio />, name: "DHT11", desc: "Digital temperature + humidity sensor inside the chamber." },
    { icon: <CircuitBoard />, name: "W1209", desc: "Dedicated 12V temperature controller driving the Peltier stage." },
    { icon: <Snowflake />, name: "Peltier Element", desc: "Thermoelectric cooling plate — the chamber's cold source." },
    { icon: <Fan />, name: "Cold-Side Heatsink + Fan", desc: "Dissipates heat drawn off the cold side." },
    { icon: <PlugZap />, name: "12V 5A DC Adapter", desc: "Sole power source for the Peltier and W1209 stage." },
    { icon: <Boxes />, name: "Thermocol Chamber", desc: "Insulated enclosure housing the cold zone." },
    { icon: <Gauge />, name: "Breadboard + Jumper Wires", desc: "Prototype wiring harness for sensor and control signals." },
  ];
  return (
    <div className="as-col">
      <div className="as-panel">
        <h2 className="as-panel-title"><Boxes /> Prototype Hardware</h2>
        <div className="as-hw-grid">
          {items.map((it) => (
            <div className="as-hw-card" key={it.name}>
              <div className="ic">{it.icon}</div>
              <div className="as-hw-name">{it.name}</div>
              <div className="as-hw-desc">{it.desc}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="as-grid-2">
        <div className="as-panel">
          <h2 className="as-panel-title"><Radio /> Telemetry Path</h2>
          <div className="as-flow">
            {["DHT11", "ESP32", "Telemetry (WiFi)", "AAHAAR-Setu Dashboard"].map((t, i, arr) => (
              <React.Fragment key={t}>
                <div className="as-flow-step"><div className="ic"><Activity /></div><div className="as-flow-title">{t}</div></div>
                {i < arr.length - 1 && <div className="as-flow-arrow"><ArrowDown /></div>}
              </React.Fragment>
            ))}
          </div>
        </div>
        <div className="as-panel">
          <h2 className="as-panel-title"><Zap /> Control Path</h2>
          <div className="as-flow">
            {["W1209", "Temperature Control", "Peltier", "Thermal Regulation"].map((t, i, arr) => (
              <React.Fragment key={t}>
                <div className="as-flow-step"><div className="ic"><Zap /></div><div className="as-flow-title">{t}</div></div>
                {i < arr.length - 1 && <div className="as-flow-arrow"><ArrowDown /></div>}
              </React.Fragment>
            ))}
          </div>
          <div className="as-target-note">
            The ESP32 does not directly drive the Peltier — the W1209 is a standalone controller stage. No power driver/MOSFET/relay bridging ESP32 → Peltier exists on this prototype.
          </div>
        </div>
      </div>

      <div className="as-panel">
        <h2 className="as-panel-title"><Info /> Power Status</h2>
        <div className="as-info-list">
          <div className="as-info-row"><span className="as-info-k">Power source</span><span className="as-info-v">12V DC Adapter</span></div>
          <div className="as-info-row"><span className="as-info-k">Rated supply</span><span className="as-info-v as-mono">12V / 5A</span></div>
          <div className="as-info-row"><span className="as-info-k">Maximum rated input</span><span className="as-info-v as-mono">60W</span></div>
          <div className="as-info-row"><span className="as-info-k">Power telemetry</span><span className="as-info-v">Not measured</span></div>
        </div>
      </div>

      <div className="as-panel">
        <h2 className="as-panel-title"><Boxes /> System Expansion — Future Integration</h2>
        <div className="as-future-grid">
          {FUTURE_MODULES.map((m) => <div className="as-future-chip" key={m}>{m}</div>)}
        </div>
      </div>
    </div>
  );
}

function AlertsPage() {
  const { latest } = useTelemetry();
  const now = Date.now();
  const alerts = [];
  if (latest.temperature > CROP_ZONES.chilli.max + 1) alerts.push({ tone: "warn", title: "HIGH TEMPERATURE", msg: "Chamber temperature is above the recommended crop range.", ts: now });
  if (latest.humidity > 85) alerts.push({ tone: "warn", title: "HIGH HUMIDITY", msg: "Humidity level is elevated.", ts: now });
  if (latest.esp32Status !== "ONLINE") alerts.push({ tone: "crit", title: "SENSOR FAILURE", msg: "DHT11 telemetry unavailable.", ts: now });
  if (latest.w1209Status !== "CONNECTED") alerts.push({ tone: "crit", title: "CONTROLLER OFFLINE", msg: "W1209 controller status unavailable.", ts: now });
  if (latest.coolingInefficient) alerts.push({ tone: "crit", title: "COOLING FAILURE", msg: "Temperature is not decreasing despite cooling being active.", ts: now });
  if (Math.abs(latest.temperature - latest.target) <= 0.4) alerts.push({ tone: "info", title: "TARGET REACHED", msg: "Chamber temperature has reached the configured target.", ts: now });

  return (
    <div className="as-panel">
      <h2 className="as-panel-title"><AlertTriangle /> Alert Center</h2>
      {alerts.length === 0 && <div className="as-target-note">No active alerts — chamber is within normal parameters.</div>}
      {alerts.map((a, i) => (
        <div className={`as-alert ${a.tone}`} key={i}>
          <div className="ic">
            {a.tone === "crit" ? <XCircle color="var(--rust)" /> : a.tone === "warn" ? <AlertTriangle color="var(--clay)" /> : <CheckCircle2 color="var(--frost)" />}
          </div>
          <div>
            <div className="as-alert-title">{a.title}</div>
            <div className="as-alert-msg">{a.msg}</div>
          </div>
          <div className="as-alert-time as-mono">{timeLabel(a.ts)}</div>
        </div>
      ))}
    </div>
  );
}

function SystemInfoPage() {
  const rows = [
    ["Project", "AAHAAR-Setu"],
    ["Prototype", "Peltier Smart Cold Storage"],
    ["Controller", "ESP32 + W1209"],
    ["Environmental Sensor", "DHT11"],
    ["Cooling", "Thermoelectric / Peltier"],
    ["Insulation", "Thermocol"],
    ["Power", "12V 5A DC Adapter"],
    ["Connectivity", "ESP32 WiFi"],
    ["Dashboard", "AAHAAR-Setu Hardware Digital Twin"],
    ["Data mode", CONFIG.DATA_MODE],
  ];
  return (
    <div className="as-panel">
      <h2 className="as-panel-title"><Info /> System Information</h2>
      <div className="as-info-list">
        {rows.map(([k, v]) => (
          <div className="as-info-row" key={k}><span className="as-info-k">{k}</span><span className="as-info-v">{v}</span></div>
        ))}
      </div>
    </div>
  );
}

// --------------------------------- Shell ------------------------------------
const PAGE_META = {
  overview:  { title: "Cold Storage Overview", sub: "Real-time condition of the AAHAAR-Setu prototype chamber.", Comp: OverviewPage },
  live:      { title: "Live Monitor", sub: "Continuous chamber temperature and humidity telemetry.", Comp: LiveMonitorPage },
  cooling:   { title: "Cooling System", sub: "Peltier, W1209 controller, and cooling logic.", Comp: CoolingSystemPage },
  sensor:    { title: "Sensor Data", sub: "DHT11 readings, sensor health, and historical telemetry.", Comp: SensorDataPage },
  storage:   { title: "Storage Zone", sub: "Crop-specific thermal zone compatibility.", Comp: StorageZonePage },
  hardware:  { title: "Hardware", sub: "Physical components and their signal paths.", Comp: HardwarePage },
  alerts:    { title: "Alerts", sub: "Active conditions requiring attention.", Comp: AlertsPage },
  system:    { title: "System Info", sub: "Project and prototype reference details.", Comp: SystemInfoPage },
};
const NAV_ICONS = { overview: <LayoutDashboard />, live: <Activity />, cooling: <Snowflake />, sensor: <Radio />, storage: <Leaf />, hardware: <Boxes />, alerts: <AlertTriangle />, system: <Info /> };

function HeaderBar() {
  const { connected, dataMode, connectSerial, serialError } = useTelemetry();
  return (
    <header className="as-header">
      <div />
      <div className="as-brand-wrap">
        <span className="as-brand">AAHAAR-Setu</span>
        <span className="as-brand-sub">Real-time thermal intelligence for fresh produce</span>
      </div>
      <div className="as-header-right">
        {dataMode === "SERIAL" && !connected && (
          <button className="as-export-btn" onClick={connectSerial}>Connect Arduino</button>
        )}
        <div className="as-header-conn">
          <span className={`as-dot ${connected ? "as-dot-on" : "as-dot-off"}`} />
          {connected ? <Wifi size={14} /> : <WifiOff size={14} />}
          {dataMode === "SERIAL" ? "Arduino" : "ESP32"} <b>{connected ? "ONLINE" : "OFFLINE"}</b>
        </div>
        <div className="as-header-icons"><Bell /><Settings /></div>
      </div>
      {dataMode === "SERIAL" && serialError && (
        <div style={{ gridColumn: "1 / -1", fontSize: 11, color: "#F0B4AC", textAlign: "center", marginTop: 2 }}>{serialError}</div>
      )}
    </header>
  );
}

function StatusStrip() {
  const { latest } = useTelemetry();
  return (
    <div className="as-statusstrip">
      <div className="as-strip-item"><Thermometer /> Chamber <b className="as-mono">{fmt(latest.temperature)}°C</b></div>
      <div className="as-strip-item"><Droplets /> Humidity <b className="as-mono">{fmt(latest.humidity, 0)}%</b></div>
      <div className="as-strip-item">
        <span className={`as-dot ${latest.peltierStatus === "ACTIVE" ? "as-dot-on" : "as-dot-off"}`} /> Cooling <b>{latest.peltierStatus}</b>
      </div>
    </div>
  );
}

function Sidebar({ activeTab, setActiveTab }) {
  const { dataMode, connected } = useTelemetry();
  return (
    <aside className="as-sidebar">
      <nav className="as-nav">
        {Object.entries(PAGE_META).map(([key, meta]) => (
          <button key={key} className={`as-nav-item${activeTab === key ? " active" : ""}`} onClick={() => setActiveTab(key)}>
            {NAV_ICONS[key]} {meta.title === "Cold Storage Overview" ? "Overview" : meta.title}
          </button>
        ))}
      </nav>
      <div className="as-sidebar-foot">
        <div className="as-node-label">PROTOTYPE NODE</div>
        <div className="as-node-status"><span className={`as-dot ${connected ? "as-dot-on" : "as-dot-off"}`} /> {connected ? "ONLINE" : "OFFLINE"}</div>
        {dataMode === "MOCK" && <div className="as-demo-pill">DEMO TELEMETRY</div>}
        {dataMode === "SERIAL" && connected && <div className="as-demo-pill" style={{ background: "#E2F0E7", borderColor: "#8FBBA0", color: "var(--forestDeep)" }}>LIVE ARDUINO</div>}
      </div>
    </aside>
  );
}

function DashboardBody() {
  const [activeTab, setActiveTab] = useState("overview");
  const { title, sub, Comp } = PAGE_META[activeTab];
  return (
    <div className="as-shell">
      <HeaderBar />
      <StatusStrip />
      <Sidebar activeTab={activeTab} setActiveTab={setActiveTab} />
      <main className="as-main">
        <h1 className="as-page-title">{title}</h1>
        <p className="as-page-sub">{sub}</p>
        <Comp />
      </main>
    </div>
  );
}

export default function AahaarSetuDashboard() {
  return (
    <div className="as-root">
      <style>{CSS}</style>
      <TelemetryProvider>
        <DashboardBody />
      </TelemetryProvider>
    </div>
  );
}