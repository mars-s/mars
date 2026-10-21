// A fake GitHub Git Data API backed by a local bare repository, for check-github-sync.mjs.
// Objects are made with git hash-object, mktree and commit-tree, so a matching SHA here
// is a real git SHA. quirks.dropTimezone mimics a server that rewrites dates to UTC.
import { git } from './github-sync.mjs';

const toGitDate = (iso) => {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|([+-])(\d\d):?(\d\d))$/.exec(iso ?? '');
  if (!m) return null;
  const off = m[7] === 'Z' ? 0 : (m[8] === '-' ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10]));
  const epoch = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000 - off * 60;
  const a = Math.abs(off);
  return `${epoch} ${off < 0 ? '-' : '+'}${String(Math.floor(a / 60)).padStart(2, '0')}${String(a % 60).padStart(2, '0')}`;
};

export function createFakeGithub({ bare, remote, defaultBranch = 'main', quirks = {} }) {
  const calls = [];
  const exists = async (sha, type) => /^[0-9a-f]{40}$/.test(sha ?? '') && (await git(bare, ['cat-file', '-t', sha], { raw: true, allowFail: true })).stdout.toString().trim() === type;
  const refOf = async (name) => {
    const r = await git(bare, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], { raw: true, allowFail: true });
    return r.code === 0 ? r.stdout.toString().trim() : null;
  };
  const empty = async () => !(await git(bare, ['for-each-ref'])).trim();
  const no = (status, message) => ({ status, data: { message, documentation_url: 'https://docs.github.com/rest' } });
  async function mktree(node) {
    const lines = [];
    for (const [name, e] of Object.entries(node)) {
      if (e.children) lines.push(`040000 tree ${await mktree(e.children)}\t${name}`);
      else lines.push(`${e.mode} ${e.type} ${e.sha}\t${name}`);
    }
    return (await git(bare, ['mktree', '-z'], { input: lines.map((l) => l + '\0').join('') })).trim();
  }
  async function request(method, path, body) {
    calls.push({ method, path, body });
    const prefix = `/repos/${remote}`;
    if (!path.startsWith(prefix)) return no(404, 'Not Found');
    const p = decodeURIComponent(path.slice(prefix.length));
    if (method === 'GET' && p === '') return { status: 200, data: { full_name: remote, default_branch: defaultBranch } };
    if (method === 'GET' && p.startsWith('/git/ref/heads/')) {
      if (await empty()) return no(409, 'Git Repository is empty.');
      const sha = await refOf(p.slice('/git/ref/heads/'.length));
      return sha ? { status: 200, data: { ref: 'refs/heads/' + p.slice(15), object: { sha, type: 'commit' } } } : no(404, 'Not Found');
    }
    if (method === 'POST' && p === '/git/blobs') {
      if (body?.encoding !== 'base64' && body?.encoding !== 'utf-8') return no(422, 'Invalid encoding');
      const sha = (await git(bare, ['hash-object', '-w', '--stdin'], { input: Buffer.from(body.content, body.encoding === 'base64' ? 'base64' : 'utf8') })).trim();
      return { status: 201, data: { sha } };
    }
    if (method === 'POST' && p === '/git/trees') {
      const files = new Map();
      if (body.base_tree) {
        if (!await exists(body.base_tree, 'tree')) return no(422, 'base_tree not found');
        const raw = (await git(bare, ['ls-tree', '-r', '-z', '--full-tree', body.base_tree], { raw: true })).stdout.toString('utf8');
        for (const rec of raw.split('\0').filter(Boolean)) { const [meta, name] = rec.split('\t'); const [mode, type, sha] = meta.split(' '); files.set(name, { mode, type, sha }); }
      }
      for (const e of body.tree ?? []) {
        for (const k of [...files.keys()]) if (k.startsWith(e.path + '/')) files.delete(k);
        if (e.sha === null) { files.delete(e.path); continue; }
        if (!['100644', '100755', '120000', '160000'].includes(e.mode)) return no(422, 'Invalid tree mode ' + e.mode);
        if (e.type === 'blob' && !await exists(e.sha, 'blob')) return no(422, 'tree.sha ' + e.sha + ' is not a valid blob');
        const parts = e.path.split('/');
        for (let i = 1; i < parts.length; i++) files.delete(parts.slice(0, i).join('/'));
        files.set(e.path, { mode: e.mode, type: e.type, sha: e.sha });
      }
      const root = {};
      for (const [path, e] of files) {
        const parts = path.split('/'); let node = root;
        for (const d of parts.slice(0, -1)) node = (node[d] ??= { children: {} }).children;
        node[parts.at(-1)] = e;
      }
      return { status: 201, data: { sha: await mktree(root) } };
    }
    if (method === 'POST' && p === '/git/commits') {
      if (!await exists(body.tree, 'tree')) return no(422, 'Tree SHA does not exist');
      for (const parent of body.parents ?? []) if (!await exists(parent, 'commit')) return no(422, 'Parent SHA does not exist or is not a commit object');
      const fix = (d) => (quirks.dropTimezone ? toGitDate(new Date(d).toISOString().slice(0, 19) + 'Z') : toGitDate(d));
      const a = body.author ?? body.committer, c = body.committer ?? body.author;
      const env = { ...process.env, GIT_AUTHOR_NAME: a.name, GIT_AUTHOR_EMAIL: a.email, GIT_AUTHOR_DATE: fix(a.date), GIT_COMMITTER_NAME: c.name, GIT_COMMITTER_EMAIL: c.email, GIT_COMMITTER_DATE: fix(c.date) };
      const args = ['-c', 'commit.gpgsign=false', 'commit-tree', body.tree, ...(body.parents ?? []).flatMap((s) => ['-p', s])];
      const sha = (await git(bare, args, { input: body.message, env })).trim();
      return { status: 201, data: { sha, tree: { sha: body.tree }, parents: (body.parents ?? []).map((s) => ({ sha: s })) } };
    }
    if (method === 'PATCH' && p.startsWith('/git/refs/heads/')) {
      const name = p.slice('/git/refs/heads/'.length);
      const old = await refOf(name);
      if (!old) return no(422, 'Reference does not exist');
      if (!await exists(body.sha, 'commit')) return no(422, 'Object does not exist');
      const ff = (await git(bare, ['merge-base', '--is-ancestor', old, body.sha], { raw: true, allowFail: true })).code === 0;
      if (!ff && !body.force) return no(422, 'Update is not a fast forward');
      await git(bare, ['update-ref', 'refs/heads/' + name, body.sha, old]);
      return { status: 200, data: { ref: 'refs/heads/' + name, object: { sha: body.sha, type: 'commit' } } };
    }
    if (method === 'POST' && p === '/git/refs') {
      if (!/^refs\/heads\/./.test(body.ref ?? '')) return no(422, 'Reference name is invalid');
      if (await refOf(body.ref.slice(11))) return no(422, 'Reference already exists');
      if (!await exists(body.sha, 'commit')) return no(422, 'Object does not exist');
      await git(bare, ['update-ref', body.ref, body.sha, '']);
      return { status: 201, data: { ref: body.ref, object: { sha: body.sha, type: 'commit' } } };
    }
    return no(404, 'Not Found');
  }
  return { request, calls };
}
