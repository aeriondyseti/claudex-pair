# Golden CLI scenarios

Each `scenarios/*.jsonl` file is one ordered, isolated end-to-end scenario.
Every nonblank line is a JSON object. The first line is metadata; subsequent
lines are CLI steps. These files describe the compatibility contract only—the
runner is intentionally implemented separately.

## Records

Metadata:

```json
{"scenario":"name","description":"purpose","agents":["claude","codex"]}
```

Step:

```json
{"step":"short-id","argv":["send","-From","claude"],"exit":0,"stdout":["Sent ask -> codex"],"stderr":[],"effects":[{"path":".pair/session.json","json":{"turn":"codex"}}]}
```

- `argv` is passed verbatim after the `pair` executable. The runner supplies a
  fresh temporary directory as the working directory.
- `exit` is the exact process exit code. Error text may be emitted on either
  stream by the PowerShell shim, so `output` means combined stdout/stderr;
  `stdout` and `stderr` are available when stream identity is contractual.
- String arrays are unordered required substrings. Extra output is allowed.
- `${name}` interpolates a value captured by an earlier step. `capture` maps a
  name to a regular expression with exactly one capture group, searched in
  combined output.
- An effect with `path` asserts that the path exists after the step. `json`
  recursively matches the listed subset of a JSON file. `json_array_length`
  applies at the optional `json_pointer` (RFC 6901). `text` lists required
  file substrings. `glob_count` applies to a glob in `path`.
- `absent: true` asserts no matching path exists. `unchanged` lists JSON
  pointers whose values must equal their values immediately before the step.
- `find` selects one file from a glob by metadata subset match, allowing
  assertions against timestamp-derived names. For JSON it matches object
  fields; for message Markdown it matches the YAML-style header fields.

All paths are relative to the scenario root. Timestamps and generated IDs are
never golden literals; scenarios capture them or locate records by content.
The `.pair` on-disk schema and message bodies remain compatibility surfaces.
