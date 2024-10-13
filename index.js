import { extension_settings } from '../../../extensions.js';
import { isTrueBoolean, isFalseBoolean } from '../../../utils.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

const locationCache = new Map();

const defaultSettings = {
    host: '',
    user: '',
    password: '',
    database: '',
    port: '',
};

async function queryDatabase(query, args) {
    const client = new Client({
        host: extension_settings.sqlquery.host,
        user: extension_settings.sqlquery.user,
        password: extension_settings.sqlquery.password,
        database: extension_settings.sqlquery.database,
        port: extension_settings.sqlquery.port,
    });

    try {
        await client.connect();
        const res = await client.query(query, args);
        return res.rows;
    } finally {
        await client.end();
    }
}

async function getWeatherCallback(args, location) {
    if (!extension_settings.sqlquery.apiKey) {
        throw new Error('No Sqlquery API key set.');
    }

    if (!location && !extension_settings.sqlquery.preferredLocation) {
        throw new Error('No location provided, and no preferred location set.');
    }

    const currentLocation = location || extension_settings.sqlquery.preferredLocation;
    const locationKey = await getLocationKey(currentLocation);
    const weatherData = await getWeatherForLocation(locationKey);
    const parsedWeather = parseWeatherData(weatherData, args);
    return parsedWeather;
}

function parseWeatherData(weatherData, args) {
    const parts = [];
    const currentUnits = args.units || extension_settings.sqlquery.units;
    const unitKey = String(currentUnits).trim().toLowerCase() === 'imperial' ? 'Imperial' : 'Metric';

    if (!isFalseBoolean(args.condition)) {
        parts.push(weatherData.WeatherText);
    }

    if (!isFalseBoolean(args.temperature)) {
        let temp = `${weatherData.Temperature[unitKey].Value}°${weatherData.Temperature[unitKey].Unit}`;

        if (isTrueBoolean(args.feelslike)) {
            temp += ` (feels like ${weatherData.RealFeelTemperature[unitKey].Value}°${weatherData.RealFeelTemperature[unitKey].Unit})`;
        }

        parts.push(temp);
    }

    if (isTrueBoolean(args.wind)) {
        parts.push(`Wind: ${weatherData.Wind.Speed[unitKey].Value} ${weatherData.Wind.Speed[unitKey].Unit} ${weatherData.Wind.Direction.English}`);
    }

    if (isTrueBoolean(args.humidity)) {
        parts.push(`Humidity: ${weatherData.RelativeHumidity}%`);
    }

    if (isTrueBoolean(args.pressure)) {
        parts.push(`Pressure: ${weatherData.Pressure[unitKey].Value} ${weatherData.Pressure[unitKey].Unit}`);
    }

    if (isTrueBoolean(args.visibility)) {
        parts.push(`Visibility: ${weatherData.Visibility[unitKey].Value} ${weatherData.Visibility[unitKey].Unit}`);
    }

    if (isTrueBoolean(args.uvindex)) {
        parts.push(`UV Index: ${weatherData.UVIndexText}`);
    }

    if (isTrueBoolean(args.precipitation)) {
        parts.push(`Precipitation: ${weatherData.PrecipitationSummary.Precipitation[unitKey].Value} ${weatherData.PrecipitationSummary.Precipitation[unitKey].Unit}`);
    }

    return parts.join(', ');
}

function parseWeatherForecastData(weatherData) {
    const start = new Date(weatherData.DailyForecasts[0].Date);
    const end = new Date(weatherData.DailyForecasts[4].Date);
    const summary = weatherData.Headline.Text;
    const parts = [];

    parts.push(`Weather forecast for ${start.toLocaleDateString()}-${end.toLocaleDateString()}: ${summary}`);

    for (const day of weatherData.DailyForecasts) {
        const dayDate = new Date(day.Date);
        const daySummary = day.Day.LongPhrase;
        const nightSummary = day.Night.LongPhrase;
        const temperature = `${day.Temperature.Minimum.Value}°${day.Temperature.Minimum.Unit} - ${day.Temperature.Maximum.Value}°${day.Temperature.Maximum.Unit}`;
        parts.push(`${dayDate.toLocaleDateString()}: ${daySummary} during the day, ${nightSummary} at night. Temperature: ${temperature}`);
    }

    return parts.join('\n');
}

async function getLocationKey(location) {
    if (locationCache.has(location)) {
        return locationCache.get(location);
    }

    const baseUrl = new URL('http://dataservice.sqlquery.com/locations/v1/search');
    const params = new URLSearchParams();
    params.append('apikey', extension_settings.sqlquery.apiKey);
    params.append('q', location);
    baseUrl.search = params.toString();

    const response = await fetch(baseUrl);

    if (!response.ok) {
        throw new Error(`Failed to get location for "${location}"`);
    }

    const data = await response.json();

    if (!Array.isArray(data) || data.length === 0) {
        throw new Error(`No location found for "${location}"`);
    }

    const locationKey = data[0].Key;
    locationCache.set(location, locationKey);
    return locationKey;
}

/**
 * Get the current weather for a location
 * @param {string} location - The location to get the weather for
 * @returns {Promise<WeatherData>} The weather information
 */
async function getWeatherForLocation(locationKey) {
    const baseUrl = new URL(`http://dataservice.sqlquery.com/currentconditions/v1/${locationKey}`);
    const params = new URLSearchParams();
    params.append('apikey', extension_settings.sqlquery.apiKey);
    params.append('details', 'true');
    baseUrl.search = params.toString();

    const response = await fetch(baseUrl);

    if (!response.ok) {
        throw new Error(`Failed to get weather for location key "${locationKey}"`);
    }

    const data = await response.json();

    if (!Array.isArray(data) || data.length === 0) {
        throw new Error(`No weather data found for location key "${locationKey}"`);
    }

    return data[0];
}

async function getForecastForLocation(locationKey, units) {
    const baseUrl = new URL(`http://dataservice.sqlquery.com/forecasts/v1/daily/5day/${locationKey}`);
    const params = new URLSearchParams();
    params.append('apikey', extension_settings.sqlquery.apiKey);
    params.append('details', 'true');
    params.append('metric', units === 'metric');
    baseUrl.search = params.toString();

    const response = await fetch(baseUrl);

    if (!response.ok) {
        throw new Error(`Failed to get forecast for location key "${locationKey}"`);
    }

    const data = await response.json();

    if (!data || typeof data !== 'object') {
        throw new Error(`No forecast data found for location key "${locationKey}"`);
    }

    return data;
}

function registerFunctionTools() {
    try {
        const { registerFunctionTool } = SillyTavern.getContext();

        if (!registerFunctionTool) {
            console.debug('[Sqlquery] Tool calling is not supported.');
            return;
        }

        const getWeatherSchema = Object.freeze({
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                location: {
                    type: 'string',
                    description: 'The location to get the weather for, e.g. "Bucharest, Romania" or "Los Angeles, CA".',
                },
                units: {
                    type: 'string',
                    description: 'The units to use for the weather data. Use "metric" or "imperial" depending on the location.',
                },
                condition: {
                    type: 'boolean',
                    description: 'The result should include the weather condition, e.g. "Clear".',
                },
                temperature: {
                    type: 'boolean',
                    description: 'The result should include the actual temperature.',
                },
                feelslike: {
                    type: 'boolean',
                    description: 'The result should include the "feels like" temperature.',
                },
                wind: {
                    type: 'boolean',
                    description: 'The result should include the wind speed and direction.',
                },
                humidity: {
                    type: 'boolean',
                    description: 'The result should include the relative humidity.',
                },
                pressure: {
                    type: 'boolean',
                    description: 'The result should include the pressure.',
                },
                visibility: {
                    type: 'boolean',
                    description: 'The result should include the visibility.',
                },
                uvindex: {
                    type: 'boolean',
                    description: 'The result should include the UV index.',
                },
                precipitation: {
                    type: 'boolean',
                    description: 'The result should include the precipitation.',
                },
            },
            required: [
                'location',
                'units',
                'condition',
                'temperature',
            ],
        });

        const getWeatherForecastSchema = Object.freeze({
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                location: {
                    type: 'string',
                    description: 'The location to get the weather for, e.g. "Bucharest, Romania" or "Los Angeles, CA".',
                },
                units: {
                    type: 'string',
                    description: 'The units to use for the weather data. Use "metric" or "imperial" depending on the location.',
                },
            },
            required: [
                'location',
                'units',
            ],
        });

        registerFunctionTool({
            name: 'GetCurrentWeather',
            displayName: 'Get Weather',
            description: 'Get the weather for a specific location. Call when the user is asking for current weather conditions.',
            parameters: getWeatherSchema,
            action: async (args) => {
                if (!extension_settings.sqlquery.apiKey) throw new Error('No Sqlquery API key set.');
                if (!args) throw new Error('No arguments provided');
                Object.keys(args).forEach((key) => args[key] = String(args[key]));
                const location = args.location || extension_settings.sqlquery.preferredLocation;
                if (!location && !extension_settings.sqlquery.preferredLocation) {
                    throw new Error('No location provided, and no preferred location set.');
                }
                const locationKey = await getLocationKey(location);
                const weatherData = await getWeatherForLocation(locationKey);
                const parsedWeather = parseWeatherData(weatherData, args);
                return parsedWeather;
            },
            formatMessage: (args) => args?.location ? `Getting the weather for ${args.location}...` : '',
        });

        registerFunctionTool({
            name: 'GetWeatherForecast',
            displayName: 'Get Weather Forecast',
            description: 'Get the daily weather forecasts for the next 5 days for a specific location. Call when the user is asking for the weather forecast.',
            parameters: getWeatherForecastSchema,
            action: async (args) => {
                if (!extension_settings.sqlquery.apiKey) throw new Error('No Sqlquery API key set.');
                if (!args) throw new Error('No arguments provided');
                Object.keys(args).forEach((key) => args[key] = String(args[key]));
                const location = args.location || extension_settings.sqlquery.preferredLocation;
                if (!location && !extension_settings.sqlquery.preferredLocation) {
                    throw new Error('No location provided, and no preferred location set.');
                }
                const units = args.units || extension_settings.sqlquery.units;
                const locationKey = await getLocationKey(location);
                const weatherData = await getForecastForLocation(locationKey, units);
                const parsedWeather = parseWeatherForecastData(weatherData, args);
                return parsedWeather;
            },
            formatMessage: (args) => args?.location ? `Getting the weather forecast for ${args.location}...` : '',
        });
    } catch (err) {
        console.error('Sqlquery function tools failed to register:', err);
    }
}

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
                acceptsMultiple: false,
                typeList: ARGUMENT_TYPE.STRING,
            }),
        ],
        // namedArgumentList: [
        //     SlashCommandNamedArgument.fromProps({
        //         name: 'units',
        //         description: 'The units to use for the weather data. Uses a preferred unit if none is provided.',
        //         typeList: ARGUMENT_TYPE.STRING,
        //         isRequired: false,
        //         acceptsMultiple: false,
        //         enumList: ['metric', 'imperial'],
        //     }),
        // ],
        callback: async (args) => {
            if (!extension_settings.sqlquery.host || !extension_settings.sqlquery.user || !extension_settings.sqlquery.password || !extension_settings.sqlquery.database) {
                throw new Error('Database connection settings are not fully configured.');
            }

            const query = args.unnamed;
            const params = args.args || [];
            // const results = await queryDatabase(query, params);
            // return JSON.stringify(results, null, 2);
            return "Hello";
        },
        returns: 'a string with the result of the SQL query execution',
    }));


    registerFunctionTools();
});
