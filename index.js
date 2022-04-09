require('dotenv').config();

const ms = require('ms');

const Logger = require('leekslazylogger');
const log = new Logger();

const Keyv = require('keyv');
const keyv = new Keyv('sqlite://database.sqlite');
keyv.on('error', error => log.error('Database Error', error));

const { Client: NotionClient } = require('@notionhq/client');
const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });

const { MovieDb } = require('moviedb-promise');
const tmdb = new MovieDb(process.env.TMDB_KEY);

const {
	Client: DiscordClient,
	Intents,
} = require('discord.js');
const discord = new DiscordClient({
	intents: [
		Intents.FLAGS.GUILDS,
		Intents.FLAGS.GUILD_SCHEDULED_EVENTS,
	],
	presence: {
		activities: [
			{
				name: 'Check the server events to see the movie schedule',
				type: 'PLAYING',
			},
		],
	},
});

discord.once('ready', async () => {
	log.success(`Connected to Discord as ${discord.user.tag}`);
	sync();
	setInterval(() =>  sync(), ms('5m'));
});

discord.login();

async function sync() {
	log.info('Syncing...');
	try {
		const now = new Date();
		const notionRes = await notion.databases.query({
			database_id: process.env.NOTION_DATABASE_ID,
			filter: {
				and: [
					{
						date: { on_or_after: now.toISOString() },
						property: 'Date',
					},
					{
						people: { is_not_empty: true },
						property: 'Host (primary)',
					},
				],
			},
		});

		for (const result of notionRes.results) {

			const data = {
				imdbUrl: result.properties.IMDb.url,
				notionId: result.id,
				timestamp: new Date(result.properties.Date.date.start).getTime(),
			};
			const match = data.imdbUrl.match(/title\/(?<id>\w*)/i);
			const imdbId = match.groups.id;
			const stored = await keyv.get(result.id);
			if (
				stored &&
				stored.timestamp === data.timestamp &&
				stored.imdbUrl === data.imdbUrl
			) continue; // skip if exists & unchanged

			const movie = await tmdb.movieInfo(imdbId);

			const guild = discord.guilds.cache.get(process.env.DISCORD_SERVER_ID);
			if (!guild) log.warn('The bot is not in the Discord server');
			if (!guild.available) log.warn('The guild is unavailable');

			const year = movie.release_date.split('-')[0];
			const image = movie.backdrop_path ? 'https://www.themoviedb.org/t/p/w1920_and_h800_multi_faces' + movie.backdrop_path : undefined;
			log.warn('NOT SETTING IMAGE, NOT SUPPORTED YET', image);
			const eventData = {
				channel: process.env.DISCORD_CINEMA_CHANNEL_ID,
				description: `${movie.adult ? '🔞 **This is an adult movie**\n': ''}${movie.genres.map(g => `\`${g.name}\``).join('  ')}\n${movie.overview}\n\nhttps://www.imdb.com/title/${imdbId}`,
				entityType: 'VOICE',
				name: movie.title + ` (${year})`,
				privacyLevel: 'GUILD_ONLY',
				reason: 'Synced from Notion',
				scheduledStartTime: data.timestamp,
			};

			if (stored?.discordId) {
				log.info(`Editing "${movie.title}" event`);
				await guild.scheduledEvents.edit(stored.discordId, eventData);
			} else {
				const event = await guild.scheduledEvents.create(eventData);
				log.info(`Creating "${movie.title}" event`);
				data.discordId = event.id;
			}

			await keyv.set(result.id, data);

		}
	} catch (error) {
		log.error(error);
	}
}