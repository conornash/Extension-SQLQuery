import { extension_settings } from '../../../extensions.js';
import { isTrueBoolean, isFalseBoolean } from '../../../utils.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

const MODULE_NAME = "Extension-SQLQuery";
const defaultSettings = {
    host: '',
    user: '',
    password: '',
    database: '',
    port: '',
};

console.log("Log");
console.info("Info");
console.warn("Warning");
console.error("Error");

async function queryDatabase(query, args) {
    const baseUrl = new URL(`http://127.0.0.1:8000/api/plugins/postgresql/sql_query`);
    const requestOptions = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query: query })
    };

    const response = await fetch(baseUrl, requestOptions);

    if (!response.ok) {
        throw new Error(`Failed to get query`);
    }

    const data = await response.json();

    if (!data || typeof data !== 'object') {
        throw new Error(`No result set`);
    }

    return data;
}

async function getAllDefinitions(table_name, args) {
    const baseUrl = new URL(`http://127.0.0.1:8000/api/plugins/postgresql/sql_query`);
    const query = `WITH RECURSIVE res AS (
SELECT DISTINCT
    *
  , UNNEST(REGEXP_MATCHES(query_text, '(?:FROM|JOIN) ([a-z0-9_]+)', 'g')) AS contributing_table
    FROM frc_sql_code
 WHERE query_name = '${table_name}'

UNION ALL

SELECT DISTINCT
  fdt.*
  , UNNEST(REGEXP_MATCHES(fdt.query_text, '(?:FROM|JOIN) ([a-z0-9_]+)', 'g')) AS contributing_table
FROM res
LEFT JOIN frc_sql_code fdt
ON res.contributing_table = fdt.query_name

), contributing_tables AS (

SELECT DISTINCT res.query_name
, t.*
FROM res
LEFT JOIN information_schema.tables t
ON res.query_name = t.table_name
WHERE t.table_schema IN ('nbs_precalc', 'qdc')
)

SELECT fsc.*
FROM contributing_tables ct
JOIN frc_sql_code fsc
ON ct.query_name = fsc.query_name
where fsc.query_name NOT IN ('frc__document_template_list_item');
`;
    const requestOptions = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query: query })
    };

    const response = await fetch(baseUrl, requestOptions);

    if (!response.ok) {
        throw new Error(`Failed to get query`);
    }

    const data = await response.json();

    if (!data || typeof data !== 'object') {
        throw new Error(`No result set`);
    }

    return data;
}

function registerFunctionTools() {
    try {
        const { registerFunctionTool } = SillyTavern.getContext();

        if (!registerFunctionTool) {
            console.debug('[SQL Database] Tool calling is not supported.');
            return;
        }

        const sqlQuerySchema = Object.freeze({
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'The SQL query to execute against the configured database.',
                },
                args: {
                    type: 'array',
                    description: 'The arguments for parameterized SQL queries.',
                    items: { type: 'string' }
                },
            },
            required: ['query'],
        });

        registerFunctionTool({
            name: 'ExecuteSqlQuery',
            displayName: 'Execute SQL Query',
            description: 'Execute a SQL query against the configured database.',
            parameters: sqlQuerySchema,
            action: async (args) => {
                if (!args) throw new Error('No arguments provided');
                const query = args.query;
                const params = args.args || [];
                const results = await queryDatabase(query, params);
                return results;
            },
            formatMessage: (args) => args?.query ? `Executing SQL query...` : '',
        });
    } catch (err) {
        console.error('SQL Database function tools failed to register:', err);
    }
}

const toConsole = (level, value)=>{
    try {
        const data = JSON.parse(value.toString());
        console[level](`[/console-${level}]`, data);
    } catch {
        console[level](`[/console-${level}]`, value);
    }
    return '';
};

jQuery(async () => {
    if (extension_settings.sqlquery === undefined) {
        extension_settings.sqlquery = defaultSettings;
    }

    for (const key in defaultSettings) {
        if (extension_settings.sqlquery[key] === undefined) {
            extension_settings.sqlquery[key] = defaultSettings[key];
        }
    }

    const html = `
    <div class="sql_database_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>SQL Database</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div>
                    <label for="sql_host">Host</label>
                    <input id="sql_host" class="text_pole" type="text" />
                </div>
                <div>
                    <label for="sql_port">Port</label>
                    <input id="sql_port" class="text_pole" type="text" />
                </div>
                <div>
                    <label for="sql_user">User</label>
                    <input id="sql_user" class="text_pole" type="text" />
                </div>
                <div>
                    <label for="sql_password">Password</label>
                    <input id="sql_password" class="text_pole" type="password" />
                </div>
                <div>
                    <label for="sql_database">Database</label>
                    <input id="sql_database" class="text_pole" type="text" />
                </div>
            </div>
        </div>
    </div>`;
    $('#extensions_settings2').append(html);

    $('#sql_host').val(extension_settings.sqlquery.host).on('input', function() {
        extension_settings.sqlquery.host = String($(this).val());
        saveSettingsDebounced();
    });

    $('#sql_port').val(extension_settings.sqlquery.port).on('input', function() {
        extension_settings.sqlquery.port = String($(this).val());
        saveSettingsDebounced();
    });

    $('#sql_user').val(extension_settings.sqlquery.user).on('input', function() {
        extension_settings.sqlquery.user = String($(this).val());
        saveSettingsDebounced();
    });

    $('#sql_password').val(extension_settings.sqlquery.password).on('input', function() {
        extension_settings.sqlquery.password = String($(this).val());
        saveSettingsDebounced();
    });

    $('#sql_database').val(extension_settings.sqlquery.database).on('input', function() {
        extension_settings.sqlquery.database = String($(this).val());
        saveSettingsDebounced();
    });

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'sqlquery',
        helpString: 'This is the SQL query to be run',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Query text',
                isRequired: true,
                typeList: ARGUMENT_TYPE.STRING,
            }),
        ],
        callback: async (args, value) => {
            const query = value;
            console.log(MODULE_NAME, query);
            const params = args.args || [];
            const results = await queryDatabase(query, params);
            return JSON.stringify(results, null, 2);
        },
        returns: 'a JSON with the result of the SQL query execution',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'get-sql-definitions',
        helpString: 'Get definitions for all code contributing towards generating the named table.',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Table name',
                isRequired: true,
                typeList: ARGUMENT_TYPE.STRING,
            }),
        ],
        callback: async (args, value) => {
            const table_name = value;
            console.log(MODULE_NAME, table_name);
            const params = args.args || [];
            const results = await getAllDefinitions(table_name, params);
            const newres = results.map(elem => "###" + elem.query_name + "\n\n```sql\n" + elem.query_text.replace(/\n\n/g, '\n') + "```\n\n");
            return newres.join('\n');
        },
        returns: 'a JSON with all code used to generate the requested table',
    }));

    registerFunctionTools();
});
