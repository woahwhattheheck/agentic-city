import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const baseUrl = 'http://127.0.0.1:3000'
const evidenceDir = path.resolve('docs/evidence/agent-83')
const secretEndpoint = 'https://operator.internal/private-agent'
const secretTask = 'PRIVATE_OPERATOR_TASK_DO_NOT_RENDER'

const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;')

fs.mkdirSync(evidenceDir, { recursive: true })

const browser = await chromium.launch()
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
})
const request = context.request

try {
  const registration = await request.post(`${baseUrl}/api/agents`, {
    data: {
      agentId: 'evidence-agent',
      model: 'claude-haiku-4-5',
      district: 'data-center',
      capabilities: ['data-indexing', 'log-analysis'],
      skillVersions: [{ id: 'log-analysis', version: '2.1.0' }],
      x402: { accepts: true, pricePerTask: '0.01 XLM' },
      status: 'active',
      endpoint: secretEndpoint,
    },
  })
  if (registration.status() !== 201 && registration.status() !== 409) {
    throw new Error(`agent registration failed: ${registration.status()} ${await registration.text()}`)
  }

  const heartbeat = await request.post(`${baseUrl}/api/agents/evidence-agent/heartbeat`, {
    data: {
      status: 'working',
      cpu: 73,
      memory: 64,
      currentTask: secretTask,
      autoRestart: true,
    },
  })
  if (!heartbeat.ok()) {
    throw new Error(`heartbeat failed: ${heartbeat.status()} ${await heartbeat.text()}`)
  }

  const profile = await context.newPage()
  const profileResponse = await profile.goto(`${baseUrl}/agents/evidence-agent`, { waitUntil: 'networkidle' })
  if (!profileResponse || profileResponse.status() !== 200) {
    throw new Error(`profile status was ${profileResponse?.status()}`)
  }
  const visibleText = await profile.locator('body').innerText()
  if (visibleText.includes(secretEndpoint) || visibleText.includes(secretTask)) {
    throw new Error('public profile rendered a seeded sensitive value')
  }
  await profile.screenshot({
    path: path.join(evidenceDir, '01-anonymous-profile.png'),
    fullPage: true,
  })

  const ogResponse = await request.get(`${baseUrl}/api/og/agent/evidence-agent`)
  if (!ogResponse.ok()) {
    throw new Error(`OG image status was ${ogResponse.status()}: ${await ogResponse.text()}`)
  }
  const ogType = ogResponse.headers()['content-type'] || ''
  if (!ogType.startsWith('image/')) {
    throw new Error(`OG response was not an image: ${ogType}`)
  }
  fs.writeFileSync(path.join(evidenceDir, '02-og-preview.png'), await ogResponse.body())

  const missing = await context.newPage()
  const missingResponse = await missing.goto(`${baseUrl}/agents/agent-that-does-not-exist`, { waitUntil: 'networkidle' })
  if (!missingResponse || missingResponse.status() !== 404) {
    throw new Error(`missing profile status was ${missingResponse?.status()}`)
  }
  await missing.screenshot({
    path: path.join(evidenceDir, '03-not-found.png'),
    fullPage: true,
  })

  const htmlResponse = await request.get(`${baseUrl}/agents/evidence-agent`)
  const html = await htmlResponse.text()
  const publicProfileResponse = await request.get(`${baseUrl}/api/agents/evidence-agent?view=public`)
  const publicHealthResponse = await request.get(`${baseUrl}/api/agents/evidence-agent/health?view=public`)
  const publicProfile = await publicProfileResponse.json()
  const publicHealth = await publicHealthResponse.json()

  const forbiddenChecks = [
    ['seeded internal endpoint', secretEndpoint],
    ['seeded private task', secretTask],
    ['endpoint property', '"endpoint"'],
    ['dependency property', '"dependencies"'],
    ['restart control', '"autoRestart"'],
  ].map(([label, token]) => ({ label, absent: !html.includes(token) }))

  const publicProfileKeys = Object.keys(publicProfile.agent || {}).sort()
  const publicHealthKeys = Object.keys(publicHealth.health || {}).sort()
  const expectedProfileKeys = ['agentId', 'capabilities', 'district', 'level', 'model', 'registeredAt', 'status', 'tasksCompleted', 'x402', 'xp'].sort()
  const expectedHealthKeys = ['agentId', 'runtimeStatus', 'status', 'uptime', 'uptimeSeconds'].sort()

  if (forbiddenChecks.some((check) => !check.absent)) {
    throw new Error(`served HTML leaked a forbidden token: ${JSON.stringify(forbiddenChecks)}`)
  }
  if (JSON.stringify(publicProfileKeys) !== JSON.stringify(expectedProfileKeys)) {
    throw new Error(`unexpected public profile keys: ${JSON.stringify(publicProfileKeys)}`)
  }
  if (JSON.stringify(publicHealthKeys) !== JSON.stringify(expectedHealthKeys)) {
    throw new Error(`unexpected public health keys: ${JSON.stringify(publicHealthKeys)}`)
  }
  if (!html.includes('evidence-agent') || htmlResponse.status() !== 200) {
    throw new Error('profile content was not present in the initial HTML')
  }

  const report = `<!doctype html>
  <html><head><meta charset="utf-8"><title>Agent #83 HTML redaction evidence</title>
  <style>
    body { font: 16px ui-monospace, SFMono-Regular, Menlo, monospace; background:#07111f; color:#dbeafe; margin:0; padding:36px; }
    h1 { color:#67e8f9; margin-top:0; } .card { background:#0f1e30; border:1px solid #26405e; border-radius:14px; padding:22px; margin:18px 0; }
    .pass { color:#86efac; font-weight:700; } code, pre { color:#bfdbfe; white-space:pre-wrap; word-break:break-word; }
    table { border-collapse:collapse; width:100%; } th,td { border-bottom:1px solid #26405e; padding:10px; text-align:left; }
  </style></head><body>
    <h1>Agent #83 — served HTML privacy evidence</h1>
    <div class="card"><div class="pass">PASS — HTTP ${htmlResponse.status()}, ${html.length.toLocaleString()} bytes, agent content present in initial HTML</div>
    <p>Anonymous browser context: no cookies, storage state, token, or session.</p></div>
    <div class="card"><h2>Forbidden-token scan</h2><table><tr><th>Field/value</th><th>Result</th></tr>
      ${forbiddenChecks.map((check) => `<tr><td>${escapeHtml(check.label)}</td><td class="pass">ABSENT</td></tr>`).join('')}
    </table></div>
    <div class="card"><h2>Public API keys</h2><p>Profile: <code>${escapeHtml(publicProfileKeys.join(', '))}</code></p>
    <p>Health: <code>${escapeHtml(publicHealthKeys.join(', '))}</code></p></div>
    <div class="card"><h2>Initial HTML excerpt</h2><pre>${escapeHtml(html.slice(0, 2200))}</pre></div>
  </body></html>`
  const reportPath = '/tmp/agent83-html-report.html'
  fs.writeFileSync(reportPath, report)
  const reportPage = await context.newPage()
  await reportPage.goto(`file://${reportPath}`, { waitUntil: 'load' })
  await reportPage.screenshot({
    path: path.join(evidenceDir, '04-served-html-redaction.png'),
    fullPage: true,
  })

  const readme = `# Agent #83 visual evidence\n\nGenerated from branch commit \`${process.env.GITHUB_SHA}\` in a fresh anonymous Chromium context.\n\n- \`01-anonymous-profile.png\`: public profile loaded without session or token.\n- \`02-og-preview.png\`: the actual Open Graph image response.\n- \`03-not-found.png\`: unknown agent route returned HTTP 404.\n- \`04-served-html-redaction.png\`: initial HTML contains profile content while seeded internal endpoint, task text, dependency, and restart-control fields are absent.\n\nThe run seeded \`${secretEndpoint}\` and \`${secretTask}\` specifically to make a leak observable. It also asserted the exact public profile and health key sets before committing these artifacts.\n`
  fs.writeFileSync(path.join(evidenceDir, 'README.md'), readme)
} finally {
  await browser.close()
}
