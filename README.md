# Inlang Language Server

Unofficial language server for [Inlang](https://inlang.com/) and Paraglide message inspection.

This project is not affiliated with, endorsed by, or maintained by the Inlang team. It was created
to power the companion Zed extension for inspecting Inlang message references.

It is heavily inspired by [opral/sherlock](https://github.com/opral/sherlock), the VS Code extension
for inspecting, previewing, editing, and linting Inlang messages.

## Related Projects

- [Inlang](https://inlang.com/)
- [Paraglide JS](https://paraglidejs.com/)
- [Sherlock](https://github.com/opral/sherlock)

## Usage

```sh
npm install -g inlang-language-server
inlang-language-server
```

The server communicates over stdio and is intended to be launched by the Zed extension or another
editor integration.

## Settings

When used through the Zed extension, settings can be passed through `lsp.inlang.initialization_options`:

```json
{
  "lsp": {
    "inlang": {
      "initialization_options": {
        "previewLocale": "de",
        "maxHintLength": 80,
        "existingMessageValueDiagnostics": false
      }
    }
  }
}
```

- `previewLocale`: locale used for previews and inlay hints.
- `maxHintLength`: maximum inlay hint text length.
- `existingMessageValueDiagnostics`: set to `false` to hide Info diagnostics for literal text that
  already matches an existing base-locale message value.

## Development

Require Vite Plus.

```sh
vp install
vp check
```
