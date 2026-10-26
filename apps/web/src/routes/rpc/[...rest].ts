import type { APIHandler } from "filesystem-routing/api";

import { createHttpHandler } from "@zandaka/api/http";

import { createContext } from "../../context";

const handleRequest = createHttpHandler(createContext);
const handle: APIHandler = ({ request }) => handleRequest(request);

export const HEAD = handle;
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
