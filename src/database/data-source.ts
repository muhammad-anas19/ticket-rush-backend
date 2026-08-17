import { config as loadEnv } from 'dotenv';
import { DataSource, DataSourceOptions } from 'typeorm';

/**
 * Standalone DataSource for the TypeORM CLI.
 *
 * The CLI runs outside Nest — there is no application context, no ConfigModule, no DI — so
 * it needs its own entry point that reads .env itself. `DatabaseModule` reuses
 * `buildDataSourceOptions()` so the CLI and the running application cannot drift apart and
 * end up migrating one database while the app talks to another.
 */
loadEnv();

export function buildDataSourceOptions(): DataSourceOptions {
  return {
    type: 'postgres',
    host: process.env.DATABASE_HOST,
    port: parseInt(process.env.DATABASE_PORT ?? '5432', 10),
    username: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,

    entities: [__dirname + '/../modules/**/*.entity{.ts,.js}'],
    migrations: [__dirname + '/migrations/*{.ts,.js}'],

    // Never true, in any environment, including local development.
    //
    // `synchronize` diffs your entities against the live schema and silently applies
    // whatever it thinks the difference is. There is no reviewable diff, no rollback, and
    // no record of what changed. It races when two instances boot at once, and it will
    // happily drop a column — and its data — because you renamed a property. Migrations are
    // code: reviewed in a pull request, versioned, and reversible.
    //
    // Keeping it false locally matters too: what you test is then what ships.
    synchronize: false,

    // Same reasoning. Migrations run explicitly, as a deliberate step, not as a side effect
    // of a process starting. Otherwise a rolling deploy has several instances racing to
    // apply the same migration.
    migrationsRun: false,

    logging: process.env.NODE_ENV === 'development' ? ['error', 'warn', 'migration'] : ['error'],
  };
}

export default new DataSource(buildDataSourceOptions());
