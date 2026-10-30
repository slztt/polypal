# Writing Mesh Editor plugins

PolyPal's **Mesh Editor** (Generate page → **Editor**, or press `E`) lists two kinds of tools:

- **Built-in operations** from the backend's mesh-op registry (`api/services/mesh_ops`) — clean-up,
  repair, decimation, smoothing, subdivision, transforms and real-world sizing.
- **Plugin tools** contributed by installed *process extensions*.

A plugin tool is an ordinary process-extension node that takes a mesh and returns a mesh, plus an
`editor` key in its manifest. The same node also works as a workflow node, so you write it once.

## The contract

In the extension's `manifest.json`, on a node whose `input` and `output` are both `"mesh"`:

```json
"editor": {
  "label": "Flatten Base",
  "category": "cleanup",
  "description": "Press the bottom of the model flat for printing or standing upright."
}
```

| Field | Required | Meaning |
|-------|----------|---------|
| `label` | no | Name shown in the editor (defaults to the node `name`). |
| `category` | no | Group in the tool list: `cleanup`, `repair`, `optimization`, `topology`, `transform`, or any custom name. Defaults to `plugins`. |
| `description` | no | One line under the name (defaults to the extension description). |

`"editor": true` is also accepted and uses all the defaults. Declaring `editor` on a node that does not
take *and* return a mesh is a manifest error, so the extension fails to load rather than misbehaving.

The tool's settings come from the node's normal `params_schema` (`int`, `float`, `select`, `string`,
plus `min`/`max`/`step`/`tooltip`); the editor renders the same form the workflow editor uses.

## How a plugin runs

When the user clicks **Apply**, PolyPal:

1. resolves the current mesh to an absolute file path;
2. runs the node through the existing process runner (a Node worker for `processor.js`, the
   extension's own venv for `processor.py`) with `input.filePath` and the form values as `params`;
3. shows the returned `filePath` as a new mesh version (undoable with `Ctrl+Z`, listed under
   **Versions**).

Write outputs inside `context.workspaceDir` (the example uses `Edits/`) so the result can be
measured, compared and exported like any other workspace mesh.

### JavaScript (`processor.js`)

```js
module.exports = async function (input, params, context) {
  // input.filePath — the mesh to edit (GLB)
  // params         — values from params_schema
  // context        — { workspaceDir, tempDir, log(msg), progress(percent, label) }
  return { filePath: '/absolute/path/to/result.glb' }
}
```

Dependencies listed in `package.json` are installed with `npm install` when the extension is installed.

### Python (`processor.py`)

Read one JSON line from stdin — `{ "input": { "filePath": … }, "params": { … }, "workspaceDir": …, "tempDir": … }` —
and print NDJSON messages to stdout: `{"type":"progress","percent":50,"label":"…"}`,
`{"type":"log","message":"…"}`, and finally `{"type":"done","result":{"filePath":"…"}}` or
`{"type":"error","message":"…"}`. A `setup.py` creates the extension's venv at install time.

## Complete example

[`docs/examples/flatten-base-plugin`](examples/flatten-base-plugin) is a working JavaScript plugin. It
bakes node transforms, finds the lowest part of the model and presses the bottom few percent onto a
flat plane — useful before 3D printing. To try it, use **Extensions → Link local folder** and pick
that directory; **Flatten Base** then appears under *Clean up* in the Mesh Editor.

## Tips

- Keep the mesh in metres (the glTF convention). PolyPal's real-world sizing, measuring and exports
  assume it.
- Prefer transforming geometry over node matrices if your tool changes the shape; PolyPal bakes node
  transforms whenever it flattens a scene, but other tools may not.
- Plugins from sources PolyPal does not recognise are marked as unverified in the editor. Only
  install extensions you trust: a process extension runs code on your machine.
