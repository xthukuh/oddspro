const CHARSET = 'utf8mb4';
const COLLATE = 'utf8mb4_unicode_ci';

// M9 (admin program 2026-07-19): reusable SMS templates + broadcast campaigns.
//
// `users.sms_opt_out` is the consent switch. It is honored by the audience
// builder in pure src/db/campaign-rules.js and CANNOT be turned off by a
// caller (spec decision 9) - transactional OTP sends deliberately ignore it
// (a user who asked for a login code asked for that message).
//
// `sms_templates.body` carries the `${message}` placeholder contract (decision
// 8): exactly one template may be `is_auth_default`, and OTP/auth sends are
// wrapped through it (fallback = raw text, so removing every template keeps
// auth working). Uniqueness of the auth default is owned by the service, not
// a partial index - MySQL has none, and a filtered-unique emulation via a
// generated column would outlive its usefulness the moment a second flag
// appears.
//
// A campaign freezes its RENDERED `message` at creation: editing the template
// afterwards must never rewrite what was already sent (the same freeze
// discipline as fixture_prematch / hot picks). `sms_campaign_recipients` is
// the per-user ledger the resumable job walks; `phone` is denormalized so a
// later account deletion leaves the delivery record intact, which is exactly
// why `user_id` is a nullable SET NULL pointer rather than a cascade.

export async function up(knex) {
    await knex.schema.alterTable('users', t => {
        t.boolean('sms_opt_out').notNullable().defaultTo(0);
    });

    await knex.schema.createTable('sms_templates', t => {
        t.charset(CHARSET);
        t.collate(COLLATE);
        t.bigIncrements('id').unsigned();
        t.string('name', 64).notNullable().unique();
        t.string('body', 480).notNullable();         // must contain ${message}
        t.boolean('is_auth_default').notNullable().defaultTo(0);
        t.bigInteger('created_by').unsigned().nullable()
            .references('id').inTable('users').onDelete('SET NULL');
        t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
        t.timestamp('updated_at').notNullable()
            .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
        t.index(['is_auth_default'], 'idx_sms_templates_auth');
    });

    await knex.schema.createTable('sms_campaigns', t => {
        t.charset(CHARSET);
        t.collate(COLLATE);
        t.bigIncrements('id').unsigned();
        t.bigInteger('created_by').unsigned().nullable()
            .references('id').inTable('users').onDelete('SET NULL');
        t.bigInteger('template_id').unsigned().nullable()
            .references('id').inTable('sms_templates').onDelete('SET NULL');
        t.string('name', 96).notNullable();
        t.text('message').notNullable();             // RENDERED text, frozen at creation
        t.json('audience').notNullable();            // { mode:'filter'|'selection', ... }
        t.string('status', 16).notNullable().defaultTo('draft');
        t.integer('total').notNullable().defaultTo(0);
        t.integer('sent').notNullable().defaultTo(0);
        t.integer('failed').notNullable().defaultTo(0);
        t.integer('segments').notNullable().defaultTo(1);
        t.integer('cost_estimate').notNullable().defaultTo(0);   // credits = total x segments
        t.timestamp('started_at').nullable();
        t.timestamp('finished_at').nullable();
        t.text('error').nullable();
        t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
        t.timestamp('updated_at').notNullable()
            .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
        t.index(['status', 'created_at'], 'idx_sms_campaigns_status');
    });

    await knex.schema.createTable('sms_campaign_recipients', t => {
        t.charset(CHARSET);
        t.collate(COLLATE);
        t.bigIncrements('id').unsigned();
        t.bigInteger('campaign_id').unsigned().notNullable()
            .references('id').inTable('sms_campaigns').onDelete('CASCADE');
        t.bigInteger('user_id').unsigned().nullable()
            .references('id').inTable('users').onDelete('SET NULL');
        t.string('phone', 20).notNullable();         // denormalized: survives user deletion
        t.string('status', 16).notNullable().defaultTo('pending');
        t.string('message_id', 64).nullable();       // provider unique_id
        t.text('error').nullable();
        t.timestamp('sent_at').nullable();
        t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
        t.timestamp('updated_at').notNullable()
            .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
        // One row per user per campaign - the idempotency guard that lets an
        // interrupted job re-plan from the ledger without double-sending.
        t.unique(['campaign_id', 'user_id'], 'uniq_campaign_user');
        // The job's work query: next pending recipients of one campaign.
        t.index(['campaign_id', 'status'], 'idx_campaign_recipients_status');
    });
}

export async function down(knex) {
    await knex.schema.dropTableIfExists('sms_campaign_recipients');
    await knex.schema.dropTableIfExists('sms_campaigns');
    await knex.schema.dropTableIfExists('sms_templates');
    await knex.schema.alterTable('users', t => {
        t.dropColumn('sms_opt_out');
    });
}
