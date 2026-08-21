'use strict';
const ssh = require('./ssh-manager');

const SEC = (name) => `@@SEC:${name}@@`;
const SAMPLE_MS = 600;

/* One round trip gathers everything, including two samples for the rate metrics. */
const SCRIPT = `
export LC_ALL=C
echo "${SEC('OS')}";      (cat /etc/os-release 2>/dev/null | grep -E '^(PRETTY_NAME|NAME|VERSION)=' ; uname -sr) 2>/dev/null
echo "${SEC('UPTIME')}";  cat /proc/uptime 2>/dev/null
echo "${SEC('LOAD')}";    cat /proc/loadavg 2>/dev/null
echo "${SEC('MEM')}";     grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null
echo "${SEC('CPUINFO')}"; grep -c '^processor' /proc/cpuinfo 2>/dev/null
echo "${SEC('T1')}";      date +%s%3N 2>/dev/null
echo "${SEC('CPU1')}";    grep '^cpu ' /proc/stat 2>/dev/null
echo "${SEC('NET1')}";    cat /proc/net/dev 2>/dev/null
sleep 0.6
echo "${SEC('T2')}";      date +%s%3N 2>/dev/null
echo "${SEC('CPU2')}";    grep '^cpu ' /proc/stat 2>/dev/null
echo "${SEC('NET2')}";    cat /proc/net/dev 2>/dev/null
echo "${SEC('DISK')}";    df -PB1 2>/dev/null | tail -n +2
echo "${SEC('PROC')}";    ps -eo pid,user:16,pcpu,pmem,rss,comm --sort=-pcpu 2>/dev/null | tail -n +2 | head -20
echo "${SEC('HERMES')}";  ps -eo pid,pcpu,pmem,etimes,args 2>/dev/null | grep -i '[h]ermes' | head -10
echo "${SEC('DOCKERPS')}";  docker ps --format '{{.ID}}|{{.Image}}|{{.Names}}|{{.State}}|{{.Status}}' 2>&1 | head -40
echo "${SEC('DOCKERIMG')}"; docker images --format '{{.Repository}}|{{.Tag}}|{{.Size}}|{{.ID}}|{{.CreatedSince}}' 2>&1 | head -40
echo "${SEC('DOCKERDF')}";  docker system df --format '{{.Type}}|{{.TotalCount}}|{{.Active}}|{{.Size}}|{{.Reclaimable}}' 2>&1 | head -10
echo "${SEC('SUPAPORTS')}"; for p in 54321 54322 54323 54324 8000 3000; do printf '%s|' "$p"; curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:$p/" 2>/dev/null || printf 'x'; printf '\\n'; done
echo "${SEC('SUPACLI')}";   command -v supabase >/dev/null 2>&1 && timeout 8 supabase status 2>&1 | head -20 || echo "__NOCLI__"
echo "${SEC('END')}"
`;

async function collect(hostId) {
  const { stdout } = await ssh.exec(hostId, SCRIPT);
  const s = split(stdout);

  const t1 = num(s.T1), t2 = num(s.T2);
  const elapsed = t1 && t2 && t2 > t1 ? (t2 - t1) / 1000 : SAMPLE_MS / 1000;

  return {
    at: Date.now(),
    os: parseOs(s.OS),
    uptimeSeconds: num((s.UPTIME || '').split(/\s+/)[0]),
    load: parseLoad(s.LOAD),
    cpu: parseCpu(s.CPU1, s.CPU2, num(s.CPUINFO)),
    memory: parseMem(s.MEM),
    disks: parseDisks(s.DISK),
    network: parseNet(s.NET1, s.NET2, elapsed),
    processes: parseProcs(s.PROC),
    hermes: parseHermes(s.HERMES),
    docker: parseDocker(s.DOCKERPS, s.DOCKERIMG, s.DOCKERDF),
    supabase: parseSupabase(s.SUPAPORTS, s.SUPACLI, s.DOCKERPS)
  };
}

/** Cheap poll used to drive the activity animation for every connected host. */
async function pulse(hostId) {
  const { stdout } = await ssh.exec(
    hostId,
    `export LC_ALL=C; ps -eo pcpu,etimes,args 2>/dev/null | grep -i '[h]ermes' | head -10`
  );
  return agentStateFrom(parseHermes(stdout));
}

function agentStateFrom(procs) {
  if (!procs.length) return { state: 'asleep', cpu: 0, procs: 0, oldest: 0 };
  const cpu = procs.reduce((a, p) => a + p.cpu, 0);
  const oldest = Math.max(...procs.map((p) => p.etimeSeconds || 0));
  let state = 'idle';
  if (cpu >= 15) state = 'working';
  else if (cpu >= 1.5) state = 'thinking';
  return { state, cpu: round(cpu, 1), procs: procs.length, oldest };
}

/* ------------------------------- parsing --------------------------------- */

function split(stdout) {
  const out = {};
  const re = /@@SEC:([A-Z0-9]+)@@\n?/g;
  const marks = [];
  let m;
  while ((m = re.exec(stdout))) marks.push({ name: m[1], start: re.lastIndex, at: m.index });
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].at : stdout.length;
    out[marks[i].name] = stdout.slice(marks[i].start, end).trim();
  }
  return out;
}

const num = (v) => {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : 0;
};
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const lines = (t) => (t || '').split('\n').map((l) => l.trim()).filter(Boolean);

function parseOs(text) {
  const out = { pretty: '', kernel: '' };
  for (const l of lines(text)) {
    const m = /^PRETTY_NAME="?(.*?)"?$/.exec(l);
    if (m) out.pretty = m[1];
    else if (/^Linux |^Darwin /.test(l)) out.kernel = l;
  }
  return out;
}

function parseLoad(text) {
  const p = (text || '').split(/\s+/);
  return { one: num(p[0]), five: num(p[1]), fifteen: num(p[2]) };
}

function parseCpu(a, b, cores) {
  const va = (a || '').split(/\s+/).slice(1).map(num);
  const vb = (b || '').split(/\s+/).slice(1).map(num);
  if (va.length < 5 || vb.length < 5) return { percent: 0, cores: cores || 0 };
  const totalA = va.reduce((x, y) => x + y, 0);
  const totalB = vb.reduce((x, y) => x + y, 0);
  // idle + iowait
  const idleA = va[3] + (va[4] || 0);
  const idleB = vb[3] + (vb[4] || 0);
  const dTotal = totalB - totalA;
  const dIdle = idleB - idleA;
  const percent = dTotal > 0 ? Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100)) : 0;
  return { percent: round(percent, 1), cores: cores || 0 };
}

function parseMem(text) {
  const kv = {};
  for (const l of lines(text)) {
    const m = /^(\w+):\s+(\d+)/.exec(l);
    if (m) kv[m[1]] = num(m[2]) * 1024;
  }
  const total = kv.MemTotal || 0;
  const available = kv.MemAvailable != null ? kv.MemAvailable : (kv.MemFree || 0) + (kv.Cached || 0);
  return {
    total,
    available,
    used: Math.max(0, total - available),
    cached: kv.Cached || 0,
    swapTotal: kv.SwapTotal || 0,
    swapUsed: Math.max(0, (kv.SwapTotal || 0) - (kv.SwapFree || 0)),
    percent: total ? round(((total - available) / total) * 100, 1) : 0
  };
}

const VIRTUAL_FS = /^(tmpfs|devtmpfs|overlay|shm|none|udev|squashfs|efivarfs|cgroup)/i;

function parseDisks(text) {
  const out = [];
  for (const l of lines(text)) {
    const p = l.split(/\s+/);
    if (p.length < 6) continue;
    const [source, size, used, avail, pcent] = p;
    const mount = p.slice(5).join(' ');
    if (VIRTUAL_FS.test(source)) continue;
    if (/^\/(snap|sys|proc|dev)\b/.test(mount)) continue;
    const total = num(size);
    if (!total) continue;
    out.push({
      source, mount, total, used: num(used), available: num(avail),
      percent: num(pcent.replace('%', ''))
    });
  }
  return out;
}

const VIRTUAL_IF = /^(lo|veth|docker|br-|virbr|tun|tap|kube|cni|flannel)/;

function netTotals(text) {
  const out = {};
  for (const l of lines(text)) {
    const m = /^([^:]+):\s*(.*)$/.exec(l);
    if (!m) continue;
    const name = m[1].trim();
    const f = m[2].split(/\s+/).map(num);
    if (f.length < 9) continue;
    out[name] = { rx: f[0], tx: f[8] };
  }
  return out;
}

function parseNet(a, b, elapsed) {
  const A = netTotals(a), B = netTotals(b);
  const interfaces = [];
  let rxRate = 0, txRate = 0, rxTotal = 0, txTotal = 0;
  for (const name of Object.keys(B)) {
    if (!A[name]) continue;
    const dRx = Math.max(0, B[name].rx - A[name].rx) / elapsed;
    const dTx = Math.max(0, B[name].tx - A[name].tx) / elapsed;
    const virtual = VIRTUAL_IF.test(name);
    interfaces.push({ name, virtual, rxRate: Math.round(dRx), txRate: Math.round(dTx), rxTotal: B[name].rx, txTotal: B[name].tx });
    if (!virtual) { rxRate += dRx; txRate += dTx; rxTotal += B[name].rx; txTotal += B[name].tx; }
  }
  interfaces.sort((x, y) => (x.virtual === y.virtual ? y.rxTotal - x.rxTotal : x.virtual ? 1 : -1));
  return { rxRate: Math.round(rxRate), txRate: Math.round(txRate), rxTotal, txTotal, interfaces };
}

function parseProcs(text) {
  return lines(text).map((l) => {
    const p = l.split(/\s+/);
    if (p.length < 6) return null;
    return {
      pid: num(p[0]), user: p[1], cpu: num(p[2]), mem: num(p[3]),
      rss: num(p[4]) * 1024, command: p.slice(5).join(' ')
    };
  }).filter(Boolean);
}

function parseHermes(text) {
  return lines(text).map((l) => {
    const p = l.trim().split(/\s+/);
    // pid pcpu pmem etimes args...  (pulse omits pid/pmem)
    const hasPid = p.length >= 5 && /^\d+$/.test(p[0]) && /^\d+(\.\d+)?$/.test(p[1]);
    const cpu = hasPid ? num(p[1]) : num(p[0]);
    const etimeSeconds = hasPid ? num(p[3]) : num(p[1]);
    const args = hasPid ? p.slice(4).join(' ') : p.slice(2).join(' ');
    return { pid: hasPid ? num(p[0]) : 0, cpu, etimeSeconds, args };
  }).filter((p) => p.args && !/\bgrep\b/.test(p.args));
}

function dockerUnavailable(text) {
  return !text || /permission denied|cannot connect|not found|command not found|Is the docker daemon/i.test(text);
}

function parseDocker(psText, imgText, dfText) {
  if (dockerUnavailable(psText)) {
    return { available: false, reason: reasonFor(psText), containers: [], images: [], usage: [] };
  }
  const containers = lines(psText).map((l) => {
    const [id, image, name, state, status] = l.split('|');
    return id ? { id, image, name, state, status } : null;
  }).filter(Boolean);

  const images = dockerUnavailable(imgText) ? [] : lines(imgText).map((l) => {
    const [repository, tag, size, id, created] = l.split('|');
    return repository ? { repository, tag, size, id, created } : null;
  }).filter(Boolean);

  const usage = dockerUnavailable(dfText) ? [] : lines(dfText).map((l) => {
    const [type, count, active, size, reclaimable] = l.split('|');
    return type ? { type, count, active, size, reclaimable } : null;
  }).filter(Boolean);

  return { available: true, reason: null, containers, images, usage };
}

function reasonFor(text) {
  if (!text) return 'no response';
  if (/permission denied/i.test(text)) return 'permission denied — add your user to the docker group';
  if (/cannot connect|daemon/i.test(text)) return 'daemon not running';
  if (/not found/i.test(text)) return 'docker not installed';
  return text.split('\n')[0].slice(0, 120);
}

const SUPA_PORTS = {
  54321: 'API gateway (Kong)',
  54322: 'Postgres',
  54323: 'Studio',
  54324: 'Inbucket',
  8000: 'Kong / self-hosted',
  3000: 'Studio / app'
};

function parseSupabase(portsText, cliText, dockerPsText) {
  const ports = lines(portsText).map((l) => {
    const [port, code] = l.split('|');
    return { port: num(port), label: SUPA_PORTS[num(port)] || '', code: code === 'x' ? null : num(code) };
  }).filter((p) => p.port);

  const containers = dockerUnavailable(dockerPsText) ? [] : lines(dockerPsText)
    .map((l) => l.split('|'))
    .filter((p) => p[2] && /supabase|gotrue|postgrest|realtime|storage-api|kong|studio/i.test(`${p[1]} ${p[2]}`))
    .map(([id, image, name, state, status]) => ({ id, image, name, state, status }));

  const cli = cliText && !cliText.includes('__NOCLI__') ? cliText : null;
  const responding = ports.filter((p) => p.code && p.code > 0);
  const detected = containers.length > 0 || !!cli || responding.length > 0;

  let health = 'not detected';
  if (detected) {
    const unhealthy = containers.filter((c) => !/^Up|running/i.test(c.status || c.state || ''));
    health = containers.length && unhealthy.length ? 'degraded' : 'healthy';
  }

  return { detected, health, containers, ports, cli };
}

module.exports = { collect, pulse, agentStateFrom, _internals: { split, parseMem, parseCpu, parseNet, parseDisks, parseDocker, parseSupabase, parseHermes } };
