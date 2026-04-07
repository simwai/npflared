interface AppEnv {
  Bindings: Env
  Variables: {
    token: typeof import('./src/db/schema').tokenTable.$inferSelect
    can: ReturnType<typeof assertTokenAccess>
  }
}
