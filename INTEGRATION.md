# HLMS Integration Guide — Daily Digest

## Phase 1: GitHub Pages (Current)

### Setup Steps

1. Create new GitHub repo: `ManageTheFamily/andrews-digest`
2. Push the `digest/` folder contents to `main` branch
3. Enable GitHub Pages: Settings → Pages → Branch: main → Folder: / (root)
4. Add secret: Settings → Secrets → `ANTHROPIC_API_KEY`
5. Digest runs daily at 6 AM CT, available at:
   `https://managethefamily.github.io/andrews-digest/`

### Manual Run
```
# PowerShell - run locally anytime
cd E:\Lucas\Personal-Productivity\digest
$env:ANTHROPIC_API_KEY = "sk-ant-..."
node fetch-digest.js
```

### Add Your Own Substack Feeds
Open `subscriptions.yaml` and add entries like:

```yaml
- name: "Your Substack Name"
  url: "https://yoursubstack.substack.com/feed"
  category: education   # or baseball, health, parenting, tech
  priority: 1
  active: true
```

---

## Phase 2: HLMS Integration (When Ready)

### 1. Add digest route to server.js

```javascript
// CLAUDE CODE PROMPT - Add Digest Route to server.js
//
// After existing parent education routes, add:

const DIGEST_OUTPUT_DIR = path.join(__dirname, 'digest', 'output');

// Serve latest digest HTML
app.get('/api/digest/latest', (req, res) => {
  const latestPath = path.join(DIGEST_OUTPUT_DIR, 'digest-latest.html');
  if (fs.existsSync(latestPath)) {
    res.sendFile(latestPath);
  } else {
    res.status(404).json({ error: 'No digest generated yet. Run: node digest/fetch-digest.js' });
  }
});

// Serve digest JSON (for future widget use)
app.get('/api/digest/data', (req, res) => {
  const files = fs.readdirSync(DIGEST_OUTPUT_DIR)
    .filter(f => f.match(/^digest-\d{4}-\d{2}-\d{2}\.json$/))
    .sort().reverse();
  
  if (files.length === 0) return res.status(404).json({ error: 'No digest data found' });
  
  const latest = JSON.parse(fs.readFileSync(path.join(DIGEST_OUTPUT_DIR, files[0]), 'utf8'));
  res.json(latest);
});

// List available digests
app.get('/api/digest/archive', (req, res) => {
  const files = fs.readdirSync(DIGEST_OUTPUT_DIR)
    .filter(f => f.match(/^digest-\d{4}-\d{2}-\d{2}\.html$/))
    .sort().reverse()
    .map(f => ({ date: f.replace('digest-', '').replace('.html', ''), file: f }));
  res.json(files);
});
```

### 2. Add `parent-digest.html` to dashboards/

Key pattern — load the generated HTML into an iframe or inject it:

```html
<!-- Option A: iframe (simplest, isolated styles) -->
<iframe 
  src="/api/digest/latest" 
  class="digest-frame"
  title="Today's Digest"
></iframe>

<!-- Option B: inject into div (allows HLMS nav to stay) -->
<div id="digest-container"></div>
<script>
  fetch('/api/digest/latest')
    .then(r => r.text())
    .then(html => {
      // The digest HTML has body.hlms-embed class support
      // to hide its own masthead when embedded
      document.getElementById('digest-container').innerHTML = html;
    });
</script>
```

### 3. Add to shared-nav.js

In the Learning dropdown section, add:
```javascript
{ id: 'digest', label: '📰 Daily Digest', href: 'parent-digest.html' }
```

### 4. Automate via Railway cron (optional)

Add to Railway project as a cron service, or use a simple endpoint:

```javascript
// POST /api/digest/generate — trigger generation manually or via cron
app.post('/api/digest/generate', requireTeacher, async (req, res) => {
  const { execFile } = await import('child_process');
  execFile('node', ['digest/fetch-digest.js'], { 
    env: { ...process.env },
    cwd: __dirname 
  }, (err, stdout) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, output: stdout });
  });
});
```

---

## Architecture Summary

```
digest/
  subscriptions.yaml       ← Edit this to manage feeds
  fetch-digest.js          ← Run this to generate
  package.json
  output/
    digest-YYYY-MM-DD.html ← Dated archive
    digest-YYYY-MM-DD.json ← Structured data
    digest-latest.html     ← Always current
  .github/
    workflows/
      generate-digest.yml  ← GitHub Actions cron

HLMS integration:
  dashboards/parent-digest.html   ← New parent portal page
  server.js                       ← /api/digest/* routes
  shared-nav.js                   ← Add to Learning dropdown
```

## Cost Estimate

With 14 feeds, ~30 articles/day, Claude Sonnet:
- Input tokens: ~15,000 (article excerpts + prompts)
- Output tokens: ~3,000 (summaries + scores)
- **Estimated cost: $0.03–0.05/day (~$1–1.50/month)**
