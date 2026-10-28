import { Generator, getConfig } from "@tanstack/router-generator";
const root = process.cwd();
const config = getConfig(
  {
    routesDirectory: "./src/routes",
    generatedRouteTree: "./src/routeTree.gen.ts",
    target: "react",
    routeTreeFileFooter: [
      [
        "import type { getRouter } from './router.tsx'",
        "import type { startInstance } from './start.ts'",
        "declare module '@tanstack/react-start' {",
        "  interface Register {",
        "    ssr: true",
        "    router: Awaited<ReturnType<typeof getRouter>>",
        "    config: Awaited<ReturnType<typeof startInstance.getOptions>>",
        "  }",
        "}",
      ].join("\n"),
    ],
  },
  root,
);
await new Generator({ config, root }).run();
console.log("ok");
