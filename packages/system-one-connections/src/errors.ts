import { SystemOneError } from "@system-one-ai/core";

export class ConnectionCatalogError extends Error {
  readonly code = "CONNECTION_CATALOG_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "ConnectionCatalogError";
  }
}

export class ConnectionSelectionError extends Error {
  readonly code = "CONNECTION_SELECTION_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "ConnectionSelectionError";
  }
}

export class MissingConnectionKeyError extends SystemOneError {
  readonly kind = "MISSING_CONNECTION_KEY";
  readonly envName: string;

  constructor(envName: string) {
    super(`Required environment variable ${envName} is not set.`, "configuration");
    this.name = "MissingConnectionKeyError";
    this.envName = envName;
  }
}
