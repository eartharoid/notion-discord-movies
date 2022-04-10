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

const imageToUri = require('image-to-uri');

const fs = require('fs');
const request = require('request');

const download = (url, path, callback) => {
	request.head(url, () => {
		request(url)
			.pipe(fs.createWriteStream(path))
			.on('close', callback);
	});
};

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
			const imageUrl = movie.backdrop_path ? 'https://www.themoviedb.org/t/p/w1920_and_h800_multi_faces' + movie.backdrop_path : undefined;
			const imageFilePath = `./tmp/${imdbId}.jpeg`;
			log.info(`Downloading cover image for ${movie.title}...`);

			download(imageUrl, imageFilePath, async () => {
				const image = imageToUri(imageFilePath);
				fs.unlinkSync(imageFilePath);
				const eventData = {
					channel_id: process.env.DISCORD_CINEMA_CHANNEL_ID,
					description: `${movie.adult ? '🔞 **This is an adult movie**\n' : ''}${movie.genres.map(g => `\`${g.name}\``).join('  ')}\n${movie.overview}\n\nhttps://www.imdb.com/title/${imdbId}`,
					entity_type: 2,
					image,
					name: movie.title + ` (${year})`,
					privacy_level: 2,
					// reason: 'Synced from Notion',
					scheduled_end_time: new Date(data.timestamp + (60000 * movie.runtime)).toISOString(),
					scheduled_start_time: new Date(data.timestamp).toISOString(),
				};

				const reqOptions = {
					body: JSON.stringify(eventData),
					headers: {
						'Authorization': `Bot ${process.env.DISCORD_TOKEN}`,
						'Content-Type': 'application/json',
						'X-Audit-Log-Reason': 'Synced from Notion',
					},
				};

				if (stored?.discordId) {
					log.info(`Editing "${movie.title}" event`);
					// await guild.scheduledEvents.edit(stored.discordId, eventData);
					request.patch({
						url: `https://discord.com/api/guilds/${guild.id}/scheduled-events/${data.discordId}`,
						...reqOptions,
					}, err => {
						if (err) log.error(err);
					});
				} else {
					log.info(`Creating "${movie.title}" event`);
					// const event = await guild.scheduledEvents.create(eventData);
					request.post({
						url: `https://discord.com/api/guilds/${guild.id}/scheduled-events`,
						...reqOptions,
					}, (err, res, body) => {
						if (err) log.error(err);
						data.discordId = body.id;
					});


				}
			});

			await keyv.set(result.id, data);

		}
	} catch (error) {
		log.error(error);
	}
}