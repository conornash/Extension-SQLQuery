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

function sqlSourceFunctionTemplate(table_name, recursive_depth) {
    return `WITH RECURSIVE res AS (
SELECT DISTINCT
0 AS recursive_depth
,   NULL AS prior_relation
,    query_name
,    query_text
, query_source
  , UNNEST(query_relations) AS contributing_table
    FROM frc_sql_code
 WHERE query_name = '${table_name}'

UNION ALL

SELECT DISTINCT
res.recursive_depth + 1 AS recursive_depth
, res.query_name AS prior_relation
, fsc.query_name
, fsc.query_text
, fsc.query_source
 , UNNEST(query_relations) AS contributing_table
FROM res
JOIN frc_sql_code fsc
ON res.contributing_table = fsc.query_name
AND res.query_name != fsc.query_name
WHERE fsc.query_source = 'Airflow'
AND fsc.query_name NOT LIKE 'rpt__%'
AND fsc.query_name NOT LIKE '%_docmodel_%'
AND fsc.query_name NOT LIKE '%permissions'
AND res.recursive_depth < ${recursive_depth}
)

SELECT DISTINCT
res.query_name
, res.query_text
FROM res
LIMIT 10;
`;
}

async function queryDatabase(query) {
    const requestOptions = {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query: query })
    };

    const response = await fetch('/api/plugins/postgresql/sql_query', requestOptions);
    if (!response.ok) {
        throw new Error(`Failed to get query`);
    }

    const data = await response.json();
    if (!data || typeof data !== 'object') {
        throw new Error(`No result set`);
    }

    return data;
}

async function getCreateTableAsDefinitions(table_name, recursive_depth) {
    const query = sqlSourceFunctionTemplate(table_name, recursive_depth);
    return queryDatabase(query);
}

async function findCandidateTableNames(measure_search_term, report_search_term) {
    const query = `SELECT query_name
, query_source
FROM frc_sql_code
WHERE query_text @@ plainto_tsquery('${measure_search_term}')
AND query_name @@ plainto_tsquery('${report_search_term}');
`;
    return queryDatabase(query);
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

        const sqlTableDDLSchema = Object.freeze({
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                table_name: {
                    type: 'string',
                    description: 'The SQL table for which the source code is sought.',
                },
                recursive_depth: {
                    type: 'string',
                    description: 'This is the number of levels of provenance to pull the CREATE TABLE AS definition. If the value is 2, it will pull the DDL of the original table, parent tables, and grandparent tables. If the value is 0, it will pull the DDL of the original table only. The default value is 1.',
                }
            },
            required: ['table_name'],
        });

        registerFunctionTool({
            name: 'getSQLTableDDLRecursively',
            displayName: 'Retrieve the definition for the table of interest and ancestor tables',
            description: 'Given a SQL Table name, return the `CREATE TABLE AS` DDL used to generate the data stored in that table along with ancestor tables up to `recursive_depth` levels of provenance.',
            parameters: sqlTableDDLSchema,
            action: async (args) => {
                if (!args) throw new Error('No arguments provided');
                const table_name = args.table_name;
                const recursive_depth =  args.recursive_depth ?? '1';
                const results = await getCreateTableAsDefinitions(table_name, recursive_depth);
                return results;
            },
            formatMessage: (args) => args?.query ? `Retrieving SQL table definition...` : '',
        });

        const findCandidateTableNamesSchema = Object.freeze({
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                measure_search_term: {
                    type: 'string',
                    description: 'A whole or partial name of a measure for which the table name to which it belongs is sought. Cannot be empty',
                },
                report_search_term: {
                    type: 'string',
                    description: 'A whole or partial name of the report to which the measure belongs. Cannot be empty.',
                },
            },
            required: ['measure_search_term', 'report_search_term'],
        });

        registerFunctionTool({
            name: 'findCandidateTableNames',
            displayName: 'Find Candidate Tables related to Measure and Report search terms',
            description: 'Given a search term for a measure and a report, this will return a list of potential tables in the database, along with whether they are constructed in Airflow or Retool. If only one argument is provided, or an empty string is given for one argument, this will return an empty result.',
            parameters: findCandidateTableNamesSchema,
            action: async (args) => {
                const measure_search_term = args.measure_search_term;
                const report_search_term = args.report_search_term;
                const results = await findCandidateTableNames(measure_search_term, report_search_term);
                return results;
            },
            formatMessage: (args) => `Searching for tables that may contain ${args.measure_search_term} within a table responsible for ${args.report_search_term}...`,
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
                description: 'This is the name of the table for which the definition is sought.',
                isRequired: true,
                typeList: ARGUMENT_TYPE.STRING,
            }),
        ],
        namedArgumentList: [
        SlashCommandNamedArgument.fromProps({ name: 'recursive_depth',
                                              description: 'This is the number of levels of provenance to pull the CREATE TABLE AS definition. If the value is 2, it will pull the DDL of the original table, parent tables, and grandparent tables. If the value is 0, it will pull the DDL of the original table only. The default value is 1.',
            typeList: [ARGUMENT_TYPE.NUMBER],
            defaultValue: '1'
        })
        ],
        callback: async (args, value) => {
            const table_name = value;
            console.log(MODULE_NAME, table_name);
            const recursive_depth = args.recursive_depth ?? '1';
            const results = await getCreateTableAsDefinitions(table_name, recursive_depth);
            const newres = results.map(elem => "###" + elem.query_name + "\n\n```sql\n" + elem.query_text.replace(/\n\n/g, '\n').split("INSERT INTO")[0].trim() + "\n\n```\n\n");
            return newres.join('\n');
        },
        returns: 'a JSON with all code used to generate the requested table',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'find-candidate-table-names',
        helpString: 'Given a search term for a measure and a report, this will return a list of potential tables in the database, along with whether they are constructed in Airflow or Retool.',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'measure_search_term',
                description: 'A whole or partial name of a measure for which the table name to which it belongs is sought.',
                isRequired: true,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'report_search_term',
                description: 'A whole or partial name of the report to which the measure belongs.',
                isRequired: true,
                typeList: [ARGUMENT_TYPE.STRING],
            }),
        ],
        callback: async (args, value) => {
            const measure_search_term = args.measure_search_term;
            const report_search_term = args.report_search_term;
            const results = await findCandidateTableNames(measure_search_term, report_search_term);
            return JSON.stringify(results, null, 2);
        },
        returns: 'a JSON with the result of the SQL query execution',
    }));

    registerFunctionTools();
});
