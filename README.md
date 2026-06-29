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

## Development

Require Vite Plus.

```sh
vp install
vp check
```
