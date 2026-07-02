const CHARSET = 'utf8mb4';
const COLLATE = 'utf8mb4_unicode_ci';

// Common table setup: charset + created_at/updated_at maintained by MySQL.
function _base(knex, t) {
    t.charset(CHARSET);
    t.collate(COLLATE);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at').notNullable()
        .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
}

export async function up(knex) {
    // --- api-sports side ---------------------------------------------------

    await knex.schema.createTable('leagues', t => {
        t.integer('id').unsigned().primary(); // natural api-sports league id
        t.string('name').notNullable();
        t.string('type', 32).nullable();
        t.string('country', 64).nullable();
        t.string('logo', 512).nullable();
        _base(knex, t);
    });

    await knex.schema.createTable('teams', t => {
        t.integer('id').unsigned().primary(); // natural api-sports team id
        t.string('name').notNullable();
        t.string('country', 64).nullable();
        t.string('logo', 512).nullable();
        _base(knex, t);
        t.index('name');
    });

    await knex.schema.createTable('fixtures', t => {
        t.integer('id').unsigned().primary(); // natural api-sports fixture id
        t.integer('league_id').unsigned().notNullable()
            .references('id').inTable('leagues').onDelete('RESTRICT');
        t.smallint('season').unsigned().notNullable();
        t.string('round', 64).nullable();
        t.datetime('kickoff').notNullable(); // Africa/Nairobi local time
        t.integer('home_team_id').unsigned().notNullable()
            .references('id').inTable('teams').onDelete('RESTRICT');
        t.integer('away_team_id').unsigned().notNullable()
            .references('id').inTable('teams').onDelete('RESTRICT');
        t.string('status', 8).notNullable().defaultTo('NS'); // api-sports short code
        t.smallint('goals_home').unsigned().nullable();
        t.smallint('goals_away').unsigned().nullable();
        t.smallint('ht_home').unsigned().nullable();
        t.smallint('ht_away').unsigned().nullable();
        t.smallint('ft_home').unsigned().nullable();
        t.smallint('ft_away').unsigned().nullable();
        t.smallint('et_home').unsigned().nullable();
        t.smallint('et_away').unsigned().nullable();
        t.smallint('pen_home').unsigned().nullable();
        t.smallint('pen_away').unsigned().nullable();
        t.string('venue').nullable();
        t.string('referee').nullable();
        t.datetime('stats_fetched_at').nullable();    // fetch-once flags
        t.datetime('lineups_fetched_at').nullable();
        t.datetime('events_fetched_at').nullable();
        t.json('metadata').nullable();
        _base(knex, t);
        t.index('kickoff');
        t.index('status');
        t.index(['league_id', 'season']);
    });

    // --- bookmaker side ----------------------------------------------------

    await knex.schema.createTable('matches', t => {
        t.bigIncrements('id').unsigned().primary();
        t.enu('provider', ['betpawa', 'betika']).notNullable();
        t.bigint('provider_match_id').unsigned().notNullable();
        t.string('match_url', 512).nullable();
        t.datetime('start_time').notNullable(); // provider local time (EAT)
        t.bigint('home_team_id').unsigned().nullable(); // provider team id
        t.string('home_team_name').notNullable();
        t.bigint('away_team_id').unsigned().nullable();
        t.string('away_team_name').notNullable();
        t.smallint('home_score_first_half').unsigned().nullable();
        t.smallint('home_score_second_half').unsigned().nullable();
        t.smallint('home_score_fulltime').unsigned().nullable();
        t.smallint('away_score_first_half').unsigned().nullable();
        t.smallint('away_score_second_half').unsigned().nullable();
        t.smallint('away_score_fulltime').unsigned().nullable();
        t.bigint('region_id').unsigned().nullable();
        t.string('region_name').nullable();
        t.bigint('category_id').unsigned().nullable();
        t.string('category_name').nullable();
        t.bigint('competition_id').unsigned().nullable();
        t.string('competition_name').nullable();
        t.integer('fixture_id').unsigned().nullable()
            .references('id').inTable('fixtures').onDelete('SET NULL');
        t.datetime('completed_at').nullable(); // set => skip in refresh loops
        t.json('metadata').nullable();
        _base(knex, t);
        t.unique(['provider', 'provider_match_id']);
        t.index('start_time');
        t.index('completed_at');
        t.index('fixture_id');
    });

    await knex.schema.createTable('odds_markets', t => {
        t.bigIncrements('id').unsigned().primary();
        t.bigint('match_id').unsigned().notNullable()
            .references('id').inTable('matches').onDelete('CASCADE');
        t.bigint('type_id').unsigned().nullable();
        t.string('type_name').notNullable();
        t.text('type_explainer').nullable();
        t.string('name').notNullable();
        t.decimal('price', 8, 2).notNullable();
        t.decimal('handicap', 6, 1).nullable();
        t.decimal('probability', 6, 3).nullable();
        _base(knex, t);
        t.index(['match_id', 'type_id']);
    });

    // --- per-fixture deep stats ---------------------------------------------

    await knex.schema.createTable('fixture_statistics', t => {
        t.bigIncrements('id').unsigned().primary();
        t.integer('fixture_id').unsigned().notNullable()
            .references('id').inTable('fixtures').onDelete('CASCADE');
        t.integer('team_id').unsigned().notNullable()
            .references('id').inTable('teams').onDelete('RESTRICT');
        t.string('type', 64).notNullable(); // e.g. "Shots on Goal"
        t.string('value', 32).nullable();
        _base(knex, t);
        t.unique(['fixture_id', 'team_id', 'type']);
    });

    await knex.schema.createTable('fixture_lineups', t => {
        t.bigIncrements('id').unsigned().primary();
        t.integer('fixture_id').unsigned().notNullable()
            .references('id').inTable('fixtures').onDelete('CASCADE');
        t.integer('team_id').unsigned().notNullable()
            .references('id').inTable('teams').onDelete('RESTRICT');
        t.string('formation', 16).nullable();
        t.integer('coach_id').unsigned().nullable();
        t.string('coach_name').nullable();
        _base(knex, t);
        t.unique(['fixture_id', 'team_id']);
    });

    await knex.schema.createTable('fixture_players', t => {
        t.bigIncrements('id').unsigned().primary();
        t.integer('fixture_id').unsigned().notNullable()
            .references('id').inTable('fixtures').onDelete('CASCADE');
        t.integer('team_id').unsigned().notNullable()
            .references('id').inTable('teams').onDelete('RESTRICT');
        t.integer('player_id').unsigned().nullable();
        t.string('player_name').notNullable();
        t.smallint('number').unsigned().nullable();
        t.string('position', 4).nullable(); // G/D/M/F
        t.string('grid', 8).nullable();     // e.g. "4:2"
        t.boolean('is_starter').notNullable().defaultTo(false);
        _base(knex, t);
        t.index('fixture_id');
    });

    await knex.schema.createTable('fixture_events', t => {
        t.bigIncrements('id').unsigned().primary();
        t.integer('fixture_id').unsigned().notNullable()
            .references('id').inTable('fixtures').onDelete('CASCADE');
        t.integer('team_id').unsigned().nullable()
            .references('id').inTable('teams').onDelete('RESTRICT');
        t.smallint('elapsed').nullable();
        t.smallint('extra').nullable();
        t.string('type', 16).notNullable(); // Goal / Card / subst / Var
        t.string('detail').nullable();
        t.string('comments').nullable();
        t.integer('player_id').unsigned().nullable();
        t.string('player_name').nullable();
        t.integer('assist_id').unsigned().nullable();
        t.string('assist_name').nullable();
        _base(knex, t);
        t.index('fixture_id');
    });

    await knex.schema.createTable('standings', t => {
        t.bigIncrements('id').unsigned().primary();
        t.integer('league_id').unsigned().notNullable()
            .references('id').inTable('leagues').onDelete('CASCADE');
        t.smallint('season').unsigned().notNullable();
        t.integer('team_id').unsigned().notNullable()
            .references('id').inTable('teams').onDelete('RESTRICT');
        t.string('group_name', 128).notNullable().defaultTo('');
        t.smallint('rank').unsigned().notNullable();
        t.smallint('points').notNullable();
        t.smallint('goals_diff').notNullable();
        t.string('form', 16).nullable();
        t.string('description').nullable();
        t.smallint('played').unsigned().notNullable().defaultTo(0);
        t.smallint('win').unsigned().notNullable().defaultTo(0);
        t.smallint('draw').unsigned().notNullable().defaultTo(0);
        t.smallint('lose').unsigned().notNullable().defaultTo(0);
        t.smallint('goals_for').unsigned().notNullable().defaultTo(0);
        t.smallint('goals_against').unsigned().notNullable().defaultTo(0);
        t.json('metadata').nullable(); // raw row incl. home/away splits
        _base(knex, t);
        t.unique(['league_id', 'season', 'team_id', 'group_name']);
    });

    // --- cross-source linking ------------------------------------------------

    await knex.schema.createTable('team_aliases', t => {
        t.bigIncrements('id').unsigned().primary();
        t.integer('team_id').unsigned().notNullable()
            .references('id').inTable('teams').onDelete('CASCADE');
        t.enu('provider', ['betpawa', 'betika']).notNullable();
        t.string('alias_name').notNullable();
        _base(knex, t);
        t.unique(['provider', 'alias_name']);
    });

    await knex.schema.createTable('league_aliases', t => {
        t.bigIncrements('id').unsigned().primary();
        t.integer('league_id').unsigned().notNullable()
            .references('id').inTable('leagues').onDelete('CASCADE');
        t.enu('provider', ['betpawa', 'betika']).notNullable();
        t.string('alias_name').notNullable(); // provider competition/category name
        _base(knex, t);
        t.unique(['provider', 'alias_name']);
    });
}

export async function down(knex) {
    // reverse FK order
    await knex.schema.dropTableIfExists('league_aliases');
    await knex.schema.dropTableIfExists('team_aliases');
    await knex.schema.dropTableIfExists('standings');
    await knex.schema.dropTableIfExists('fixture_events');
    await knex.schema.dropTableIfExists('fixture_players');
    await knex.schema.dropTableIfExists('fixture_lineups');
    await knex.schema.dropTableIfExists('fixture_statistics');
    await knex.schema.dropTableIfExists('odds_markets');
    await knex.schema.dropTableIfExists('matches');
    await knex.schema.dropTableIfExists('fixtures');
    await knex.schema.dropTableIfExists('teams');
    await knex.schema.dropTableIfExists('leagues');
}
