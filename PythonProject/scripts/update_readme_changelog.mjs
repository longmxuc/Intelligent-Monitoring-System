#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const START_MARKER = '<!-- CHANGELOG_START -->';
const END_MARKER = '<!-- CHANGELOG_END -->';
const MAX_ENTRIES = Number(process.env.CHANGELOG_LIMIT || 12);

function extractChangelogData(changelogPath) {
    const content = readFileSync(changelogPath, 'utf8');
    const match = content.match(/const\s+CHANGELOG_DATA\s*=\s*(\[[\s\S]*?\]);/);
    if (!match) {
        throw new Error('无法在 changelog 数据文件中找到 CHANGELOG_DATA 定义');
    }
    const arrayLiteral = match[1];
    return runInNewContext(`(${arrayLiteral})`);
}

function buildMarkdown(data) {
    const entries = data.slice(0, MAX_ENTRIES).map(entry => {
        const dateText = entry.date?.replace(/^更新日期：/, '') || '';
        const star = entry.isImportant ? ' ⭐' : '';
        const headerParts = [entry.version];
        if (dateText) headerParts.push(dateText);
        const header = `### ${headerParts.join(' · ')}${star}`;
        const items = Array.isArray(entry.items) ? entry.items : [];
        const bullets = items.map(item => `- ${item}`).join('\n');
        return `${header}\n${bullets}`;
    });

    const sections = [
        '## 更新日志',
        '> 以下内容由 `node scripts/update_readme_changelog.mjs` 自动生成，数据来源 `web/changelog-data.js`。',
        '',
        entries.join('\n\n')
    ];

    if (data.length > MAX_ENTRIES) {
        sections.push('');
        sections.push(`> ……其余 ${data.length - MAX_ENTRIES} 条请查看在线网站\`https://znhj.iepose.cn\`-功能-关于项目 或者 \`web/changelog-data.js\``);
    }

    return sections.join('\n').trim();
}

function injectIntoReadme(readmePath, markdown) {
    const content = readFileSync(readmePath, 'utf8');
    const block = `${START_MARKER}\n${markdown}\n${END_MARKER}`;

    if (content.includes(START_MARKER) && content.includes(END_MARKER)) {
        const updated = content.replace(
            new RegExp(`${START_MARKER}[\\s\\S]*?${END_MARKER}`),
            block
        );
        writeFileSync(readmePath, updated);
    } else {
        const finalContent = `${content.trimEnd()}\n\n${block}\n`;
        writeFileSync(readmePath, finalContent);
    }
}

function main() {
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const projectRoot = resolve(scriptDir, '..'); // PythonProject 目录
    const changelogPath = resolve(projectRoot, 'web', 'changelog-data.js');
    // 将更新日志注入到仓库根目录的总 README 中
    const repoRoot = resolve(projectRoot, '..');
    const readmePath = resolve(repoRoot, 'README.md');

    const changelog = extractChangelogData(changelogPath);
    const markdown = buildMarkdown(changelog);
    injectIntoReadme(readmePath, markdown);
    console.log('README 更新日志已同步。');
}

main();
