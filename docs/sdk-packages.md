# Installable, typed SDK packages

The packages are typed ESM implementations published under the `@reapp-sdk` scope.
The `@reapp` scope is unavailable to this project, so the packages map one-to-one:
`@reapp/stellar` → `@reapp-sdk/stellar`, `@reapp/ap2` → `@reapp-sdk/ap2`, and
`@reapp/express-middleware` → `@reapp-sdk/express-middleware`.

```bash
npm install @reapp-sdk/stellar@0.2.2 @reapp-sdk/ap2@0.3.0 @reapp-sdk/express-middleware@0.2.2
```

Each package contains TypeScript declarations, API documentation, and a usage example
in its packed README. The gate check builds real tarballs for every public package,
installs all five into an empty project, strict-typechecks their public imports,
executes ESM imports and the CLI binary, and rejects lifecycle install scripts or
source/secret leakage.

## Evidence

```bash
npm ci
npm run gatecheck:t2
```
