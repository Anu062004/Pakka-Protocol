import type { IncomingMessage, ServerResponse } from "node:http";
import { createHandler, publicHosting } from "../backend/server.ts";
import { loadDeployment } from "../backend/project.ts";
import { rpcProvider } from "../backend/rpc.ts";
import { ReadService } from "../backend/read-service.ts";
import type { Manifest } from "../backend/types.ts";

// Serverless invocations share module scope while warm, so the manifest and the read
// service (and its provider) are created once rather than per request.
let manifest: Manifest | null = null;
try { manifest = loadDeployment(); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }

let service: ReadService | undefined;
const configured = publicHosting(process.env);

// The deployment hostname is only known to the platform, so it is read from the host's own
// environment instead of requiring API_ALLOWED_HOSTS to be set before the first deploy.
const platformHosts = [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL]
  .filter((host): host is string => Boolean(host));

const handler = createHandler({
  manifest,
  exposeLocalPaths: false,
  allowedHosts: [...configured.allowedHosts, ...platformHosts],
  allowedOrigins: configured.allowedOrigins ?? (platformHosts.length ? platformHosts.map((h) => `https://${h}`) : null),
  getService: () => {
    if (!manifest) throw new Error("TESTNET_DEPLOYMENT_MISSING");
    if (!service) service = new ReadService({ provider: rpcProvider(process.env), manifest });
    return service;
  },
});

export default function (req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  return handler(req, res);
}
