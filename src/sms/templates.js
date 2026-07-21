import { db } from '../db/connection.js';
import { renderTemplate, templateBodyIssue, DEFAULT_AUTH_TEMPLATE } from '../db/campaign-rules.js';
import { AuthError } from '../errors.js';

// The one owner of the `sms_templates` table (M9): thin knex over the pure
// rules in src/db/campaign-rules.js, same service idiom as auth.js/settings.js.
//
// This module exists SEPARATELY from src/campaigns.js on purpose. auth.js needs
// the auth-default wrap for OTP sends, and campaigns.js needs AuthError from
// auth.js - putting the table access in campaigns.js would close that loop into
// an import cycle (the T9 adjudicators split, same reasoning). Dependencies run
// one way: auth.js -> templates.js, campaigns.js -> templates.js. AuthError
// itself lives in src/errors.js precisely so this module can throw it.

// Exactly one row may be the auth default. Enforced HERE rather than by a
// partial unique index (MySQL has none): the flag is cleared across the table
// and set on the winner inside one transaction.
async function _claimAuthDefault(trx, id) {
    await trx('sms_templates').whereNot('id', id).update({ is_auth_default: 0 });
    await trx('sms_templates').where('id', id).update({ is_auth_default: 1 });
}

export async function listTemplates() {
    return db('sms_templates').orderBy([{ column: 'is_auth_default', order: 'desc' }, { column: 'name', order: 'asc' }]);
}

export async function getTemplate(id) {
    return db('sms_templates').where('id', Number(id) || 0).first();
}

// Create or update. `body` is validated by the pure rule (the route also parses
// templateSchema - this is the defense-in-depth copy, and the ONLY gate for
// non-route callers). Returns the stored row.
export async function saveTemplate({ id = null, name, body, is_auth_default = false }, actorId = null) {
    const issue = templateBodyIssue(body);
    if (issue) throw new AuthError(400, issue);
    const row = { name: String(name).trim(), body: String(body) };
    // Distinguish "no id supplied" (create) from "a malformed id was supplied"
    // (400). `Number(id) || null` collapsed both, so PUT .../templates/abc - or
    // /0 - silently CREATED a new template instead of 404-ing.
    let templateId = null;
    if (id != null && id !== '') {
        templateId = Number(id);
        if (!Number.isInteger(templateId) || templateId <= 0) {
            throw new AuthError(400, 'Invalid template id');
        }
    }
    await db.transaction(async trx => {
        if (templateId) {
            const existing = await trx('sms_templates').where('id', templateId).first();
            if (!existing) throw new AuthError(404, 'Template not found');
            await trx('sms_templates').where('id', templateId).update(row);
        } else {
            const [newId] = await trx('sms_templates').insert({ ...row, created_by: actorId });
            templateId = newId;
        }
        // Explicitly CLEAR the flag when it is turned off on the current
        // default - previously only the truthy branch did anything, so there
        // was no API path back to "no auth template" short of deleting the row.
        if (is_auth_default) await _claimAuthDefault(trx, templateId);
        else await trx('sms_templates').where('id', templateId).update({ is_auth_default: 0 });
    });
    return getTemplate(templateId);
}

// Deleting the auth default is allowed: wrapAuthText falls back to the built-in
// default, so auth SMS keeps working with no template rows at all.
export async function deleteTemplate(id) {
    const n = await db('sms_templates').where('id', Number(id) || 0).del();
    if (!n) throw new AuthError(404, 'Template not found');
    return { deleted: n };
}

// The active auth-wrap body, or null when none is configured.
export async function authDefaultBody() {
    const row = await db('sms_templates').where('is_auth_default', 1).first();
    return row?.body ?? null;
}

// Wrap transactional (OTP / auth) text in the configured auth template, e.g.
// "Your Odds Pro verification code is 123456." -> "[OP] Your Odds Pro ...".
//
// FAIL-OPEN, deliberately: this sits in the OTP send path, so a missing table,
// an unset default or a DB hiccup must degrade to the raw text rather than
// block a user from signing in. Backward compatible by construction - with no
// template rows the sent bytes are exactly what they were before M9.
export async function wrapAuthText(text) {
    try {
        const body = await authDefaultBody();
        if (!body) return text;
        return renderTemplate(body, { message: text });
    } catch (e) {
        console.error(`[sms] auth template lookup failed, sending raw text: ${e?.message ?? e}`);
        return text;
    }
}

export { DEFAULT_AUTH_TEMPLATE };
