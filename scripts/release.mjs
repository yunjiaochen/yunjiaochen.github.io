#!/usr/bin/env node
/**
 * 手动发布：本地跑门禁 → 提交 → 推送到 main → 由 GitHub Actions 发布
 * ---------------------------------------------------------------------------
 * 为什么需要它：线上发布走 .github/workflows/deploy.yml，而它只由 push 触发。
 * 直接 git push 也能发布，但门禁是 CI 里才跑的，失败了要等几分钟才知道；
 * 这个脚本把同样的门禁先在本地跑一遍，过了才提交，省掉一轮往返。
 *
 * 用法：
 *   npm run release                     完整流程：门禁 + 构建 + 提交 + 推送
 *   npm run release -- -m "提交信息"     指定提交信息，跳过交互输入
 *   npm run release -- --dry-run        只跑门禁与构建，不提交不推送
 *   npm run release -- --skip-gates      跳过门禁，只提交与推送（急着发时用）
 *   npm run release -- --no-push         提交但不推送，自己检查后再推
 *   npm run release -- --yes            不询问，直接按默认提交信息提交
 *
 * 注意：deploy.yml 里有一道「禁止陈旧运行」的守卫，它要求本次运行的提交
 * 就是 main 的最新提交。所以推送前会先 fetch 并确认没有落后远端，落后就先
 * rebase，避免推上去被守卫拦下。
 *
 * 发布成功后到 Actions 页面看进度：
 *   https://github.com/<owner>/<repo>/actions/workflows/deploy.yml
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const DRY_RUN = has('--dry-run');
const SKIP_GATES = has('--skip-gates');
const NO_PUSH = has('--no-push');
const ASSUME_YES = has('--yes') || DRY_RUN;
const MESSAGE = valueOf('-m') ?? valueOf('--message');

if (has('-h') || has('--help')) {
  /* 直接打印文件顶部的注释块，避免帮助文案和实现各写一份。
     只取第一段 /** ... *\/，后面的函数注释不进入帮助。 */
  const doc = [];
  for (const line of readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n')) {
    if (line.startsWith('/**')) continue;
    if (line.trim() === '*/') break;
    if (/^ \*/.test(line)) doc.push(line.replace(/^ \* ?/, ''));
  }
  console.log(doc.join('\n').trimEnd());
  process.exit(0);
}

/* 终端着色：管道或 NO_COLOR 时自动降级为纯文本 */
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = paint('1');
const dim = paint('2');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');
const cyan = paint('36');

let stepNo = 0;
const totalSteps = DRY_RUN ? 4 : 6;
const step = (title) => console.log(`\n${bold(`[${++stepNo}/${totalSteps}]`)} ${bold(title)}`);
const ok = (text) => console.log(`  ${green('✓')} ${text}`);
const warn = (text) => console.log(`  ${yellow('!')} ${text}`);

function die(message, hint) {
  console.error(`\n${red('发布中止')}：${message}`);
  if (hint) console.error(dim(`  ${hint}`));
  process.exit(1);
}

/** 跑命令并实时透传输出；返回 { code, stdout }。stdout 同时被捕获用于判断。 */
function run(cmd, cmdArgs, { capture = false, env = {} } = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd: root,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (result.error) die(`无法执行 ${cmd}：${result.error.message}`);
  return { code: result.status ?? 1, stdout: (result.stdout ?? '').trim() };
}

const git = (gitArgs, opts) => run('git', gitArgs, opts);

function gitOut(gitArgs) {
  const { code, stdout } = git(gitArgs, { capture: true });
  return code === 0 ? stdout : '';
}

/* -------------------------------------------------------------------------- */
/* 前置检查                                                                     */
/* -------------------------------------------------------------------------- */

const branch = gitOut(['branch', '--show-current']);
if (branch !== 'main') {
  die(`当前分支是 ${branch || '(游离 HEAD)'}，不是 main`,
      'deploy.yml 只在 main 上有 push 触发；先 git switch main');
}

const remoteUrl = gitOut(['remote', 'get-url', 'origin']);
if (!remoteUrl) die('没有配置 origin 远端', 'git remote add origin <仓库地址>');

/* 只有 GitHub 远端才有 Actions 与 Pages，本地裸库推送不会发布 */
const actionsUrl = (() => {
  const m = remoteUrl.match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/);
  return m ? `https://github.com/${m.groups.owner}/${m.groups.repo}/actions/workflows/deploy.yml` : null;
})();
if (!actionsUrl) {
  warn(`origin 不是 GitHub 仓库（${remoteUrl}），推送不会触发 Pages 发布`);
}

let identityMissing = false;
for (const key of ['user.name', 'user.email']) {
  if (!gitOut(['config', '--get', key])) {
    identityMissing = true;
    warn(`git 缺少 ${key}，正式提交时会失败`);
  }
}

console.log(`${bold('发布目标')}  ${cyan(remoteUrl)}`);
console.log(`${bold('当前分支')}  main  ${dim(gitOut(['log', '-1', '--format=%h %s']))}`);

/* -------------------------------------------------------------------------- */
/* 1. 门禁：与 CI 里跑的是同一组命令，本地先过一遍                                */
/* -------------------------------------------------------------------------- */

step('本地门禁（主题完整性 / 设计规范 / 公众号回归 / 类型检查）');

const gates = [
  ['主题完整性', 'npm', ['run', 'verify:theme']],
  ['设计规范自检', 'npm', ['run', 'audit']],
  ['公众号导出回归', 'npm', ['run', 'test:wechat']],
  ['类型检查', 'npm', ['run', 'check']],
];

if (SKIP_GATES) {
  warn('已用 --skip-gates 跳过门禁，CI 仍会执行，失败时发布会被拦下');
} else {
  for (const [label, cmd, cmdArgs] of gates) {
    const { code } = run(cmd, cmdArgs);
    if (code !== 0) {
      die(`${label} 未通过`, '先修掉失败项；急着发可以用 --skip-gates，但 CI 会再拦一次');
    }
    ok(label);
  }
}

/* -------------------------------------------------------------------------- */
/* 2. 本地构建：用线上同样的 SITE_URL / BASE_PATH 复现一次，确认 base 拼接正确    */
/* -------------------------------------------------------------------------- */

step('本地构建（复现线上的 SITE_URL 与 BASE_PATH）');

const { siteConfig } = await import(join(root, 'site.config.ts')).catch(() => ({ siteConfig: null }));
const siteUrl = process.env.SITE_URL ?? siteConfig?.site?.url;
const basePath = process.env.BASE_PATH ?? siteConfig?.site?.base ?? '/';

const { code: buildCode } = run('npm', ['run', 'build'], {
  env: {
    SITE_URL: siteUrl ?? '',
    BASE_PATH: basePath,
    ASTRO_TELEMETRY_DISABLED: '1',
  },
});
if (buildCode !== 0) die('构建失败', '构建产物不完整时不要推送');
ok(`构建通过 ${dim(`SITE_URL=${siteUrl} BASE_PATH=${basePath || '(空)'}`)}`);

/* -------------------------------------------------------------------------- */
/* 3. 确认待发布的内容                                                          */
/* -------------------------------------------------------------------------- */

step('待发布内容');

const status = gitOut(['status', '--porcelain']);
if (!status) {
  warn('工作区干净，没有新的改动可提交');
} else {
  for (const line of status.split('\n')) {
    /* porcelain 格式为「XY 路径」：X 是暂存区状态、Y 是工作区状态。
       两者都可能为空（例如只是工作区修改时 X 为空格），所以状态码长度是 1 到 2。 */
    const match = line.match(/^(?<code>.{1,2}) (?<file>.+)$/);
    if (!match) continue;
    const { code, file } = match.groups;
    const mark = code.includes('?') ? '新增' : code.includes('D') ? '删除' : '修改';
    console.log(`  ${yellow(mark)} ${file}`);
  }
}

/* 远端领先时先 rebase：deploy.yml 的陈旧运行守卫要求提交就是 main 最新提交 */
const fetched = git(['fetch', 'origin', 'main'], { capture: true });
if (fetched.code !== 0) {
  warn('fetch origin main 失败（网络或权限问题），跳过落后检查');
} else {
  const behind = gitOut(['rev-list', '--count', 'HEAD..origin/main']);
  const ahead = gitOut(['rev-list', '--count', 'origin/main..HEAD']);
  if (Number(behind) > 0) {
    warn(`本地落后远端 ${behind} 个提交，ahead ${ahead} 个`);
  } else {
    ok(`与 origin/main 同步（本地领先 ${ahead} 个提交）`);
  }
}

if (DRY_RUN) {
  step('干跑结束');
  ok('门禁与构建都通过，未提交也未推送');
  console.log(dim('\n去掉 --dry-run 即可正式发布。'));
  process.exit(0);
}

if (identityMissing) {
  die('git 缺少 user.name 或 user.email，提交会失败',
      '设置一次即可：git config --global user.name "你的名字" && git config --global user.email "你的邮箱"');
}

/* -------------------------------------------------------------------------- */
/* 4. 提交                                                                     */
/* -------------------------------------------------------------------------- */

step('提交');

const hasStaged = git(['diff', '--cached', '--quiet'], { capture: true }).code !== 0;

if (!hasStaged) {
  /* 没有暂存内容时，判断是否「没有改动但本地领先」，这也是可发布的状态 */
  const aheadCount = Number(gitOut(['rev-list', '--count', 'origin/main..HEAD']) || 0);
  if (!status && aheadCount > 0) {
    warn(`工作区干净，但有 ${aheadCount} 个已提交的本地提交待推送`);
  } else if (!status) {
    die('没有任何改动，也没有待推送的提交，没有可发布的内容',
        '写点东西，或者确认改动是否已经提交过');
  } else {
    const message = MESSAGE
      ?? `更新：${new Date().toISOString().slice(0, 10)} 发布`;
    if (!MESSAGE && !ASSUME_YES) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question(`  提交信息 ${dim(`[${message}]`)}：`)).trim();
      rl.close();
      git(['add', '-A']);
      if (git(['commit', '-m', answer || message]).code !== 0) die('提交失败');
    } else {
      git(['add', '-A']);
      if (git(['commit', '-m', message]).code !== 0) die('提交失败');
    }
    ok(`已提交 ${dim(gitOut(['log', '-1', '--format=%h %s']))}`);
  }
} else {
  const message = MESSAGE ?? '更新站点内容';
  if (git(['commit', '-m', message]).code !== 0) die('提交失败');
  ok(`已提交 ${dim(gitOut(['log', '-1', '--format=%h %s']))}`);
}

/* -------------------------------------------------------------------------- */
/* 5. 推送                                                                     */
/* -------------------------------------------------------------------------- */

if (NO_PUSH) {
  step('跳过推送');
  warn('已用 --no-push，改动只提交在本地');
  console.log(dim('\n确认无误后运行：git push origin main'));
  process.exit(0);
}

step('推送到 origin/main');

/* 落后远端时先 rebase，否则推上去会被陈旧运行守卫拦下 */
const behindNow = Number(gitOut(['rev-list', '--count', 'HEAD..origin/main']) || 0);
if (behindNow > 0) {
  warn(`远端有新提交（落后 ${behindNow} 个），先 rebase`);
  if (git(['rebase', 'origin/main']).code !== 0) {
    git(['rebase', '--abort'], { capture: true });
    die('rebase 有冲突，已回滚到 rebase 前的状态',
        '手动解决冲突后重新运行本脚本');
  }
  ok('rebase 完成');
}

if (git(['push', 'origin', 'main']).code !== 0) {
  die('推送失败', '检查网络与 SSH key（远端用的是 git@github.com 协议）');
}
ok(`已推送 ${dim(gitOut(['log', '-1', '--format=%h %s']))}`);

/* -------------------------------------------------------------------------- */
/* 6. 结果                                                                     */
/* -------------------------------------------------------------------------- */

step('发布已触发');

console.log(`  ${green('Actions')}  ${cyan(actionsUrl ?? '（远端不是 GitHub，无 Actions）')}`);
if (siteUrl) console.log(`  ${green('线上地址')}  ${cyan(siteUrl)}`);
console.log(dim('\n  CI 会重跑一遍门禁（主题校验 / 设计自检 / 公众号回归），然后部署到 Pages。'));
console.log(dim('  约 1 到 2 分钟后刷新线上地址；失败看 Actions 日志。'));
console.log(dim('  要重新发布同一个提交，用那次运行的 Re-run，不要重跑历史运行。'));
