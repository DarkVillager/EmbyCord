const {
	app,
	BrowserWindow,
	ipcMain,
	Tray,
	Menu,
	shell,
	dialog,
	Notification
} = require('electron');
const crypto = require('crypto');
const dedent = require('dedent-js');
const fs = require('fs');
const os = require('os');
const unhandled = require('electron-unhandled');
const contextMenu = require('electron-context-menu');
const { is, chromeVersion, electronVersion, openNewGitHubIssue } = require('electron-util');
const path = require('path');
const { v4 } = require('uuid');
const Store = require('electron-store');
const keytar = require('keytar');
const StartupHandler = require('./utils/startupHandler');
const MBClient = require('./utils/MBClient');
const UpdateChecker = require('./utils/updateChecker');
const Logger = require('./utils/logger');
const serverDiscoveryClient = require('./utils/serverDiscoveryClient');
const { scrubObject, booleanToYN } = require('./utils/helpers');
const { version, name, author, homepage } = require('./package.json');
const { Client, ActivityType } = require("minimal-discord-rpc");
const {
	clientIds,
	iconUrl,
	updateCheckInterval,
	logRetentionCount,
	discordConnectRetryMS,
	MBConnectRetryMS,
	presenceUpdateIntervalMS,
	maximumSessionInactivity,
	maxLogFileSizeMB
} = require('./config.json');

/**
 * @type {BrowserWindow}
 */
let mainWindow;

/**
 * @type {Tray}
 */
let tray;

/**
 * @type {MBClient}
 */
let mbc;
let RPC;

let presenceUpdate;
let connectRPCTimeout;
let updateChecker;

(async () => {
	const oldConfigFile = path.join(app.getPath('userData'), 'config.json');
	if (fs.existsSync(oldConfigFile)) fs.unlinkSync(oldConfigFile); // For security reasons we will delete the old config file as the new one will be encrypted, this one may contain sensitive information

	let encryptionKey = await keytar.getPassword(name, 'dpkey');
	if (!encryptionKey) {
		encryptionKey = crypto.randomBytes(32).toString('hex');
		await keytar.setPassword(name, 'dpkey', encryptionKey);
	}

	const store = new Store({
		encryptionKey,
		name: 'settings',
		schema: {
			enableDebugLogging: {
				type: 'boolean',
				default: false
			},
			isConfigured: {
				type: 'boolean',
				default: false
			},
			useTimeElapsed: {
				type: 'boolean',
				default: false
			},
			UUID: {
				type: 'string',
				default: v4()
			},
			doDisplayStatus: {
				type: 'boolean',
				default: true
			},
			servers: {
				type: 'array',
				default: []
			}
		}
	});
	const logger = new Logger(
		is.development ? 'console' : 'file',
		path.join(app.getPath('userData'), 'logs'),
		logRetentionCount,
		name,
		maxLogFileSizeMB,
		store.get('enableDebugLogging')
	);
	const startupHandler = new StartupHandler(app, name);
	const checker = new UpdateChecker(author, name, version);

	const debugInfo = () => {
		return dedent`DEBUG INFO:
			Development Mode: ${is.development}
			Platform: ${process.platform} (Version ${os.release()})
			Architecture: ${process.arch}
			EmbyCord version: ${version}
			Node version: ${process.versions.node}
			Electron version: ${electronVersion}
			Chrome version: ${chromeVersion}
		`;
	}

	logger.info('Starting app...');
	logger.info(debugInfo());

	contextMenu({
		showLookUpSelection: false,
		showSearchWithGoogle: false
	});

	unhandled({
		logger: error => logger.error(error),
		showDialog: true,
		reportButton: error => {
			openNewGitHubIssue({
				user: author,
				repo: name,
				labels: ['bug'],
				body: `\`\`\`\n${error.stack}\n\`\`\`\n\n---\n\n${debugInfo()}`
			})
		}
	});

	const startApp = () => {
		mainWindow = new BrowserWindow({
			width: 480,
			height: 310,
			minimizable: false,
			maximizable: false,
			webPreferences: {
				nodeIntegration: true,
				contextIsolation: false,
				enableRemoteModule: true
			},
			resizable: false,
			title: name,
			show: false
		});

		// only allow one instance
		const lockedInstance = app.requestSingleInstanceLock();
		if (!lockedInstance) return app.quit();

		// in development mode we allow resizing
		if (is.development) {
			mainWindow.resizable = true;
			mainWindow.maximizable = true;
			mainWindow.minimizable = true;
		} else {
			mainWindow.setMenu(null);
		}

		app.setAppUserModelId(name);

		if (store.get('isConfigured')) {
			startPresenceUpdater();
			moveToTray();
		} else {
			loadWindow('configure', { x: 600, y: 300 }, false);
		}

		checkForUpdates();
		updateChecker = setInterval(checkForUpdates, updateCheckInterval);
	};

	const getSelectedServer = () => store.get('servers').find((server) => server.isSelected);

	const resetApp = () => {
		store.clear();

		stopPresenceUpdater();

		tray.destroy();

		loadWindow('configure', { x: 600, y: 300 }, false);
	};

	const toggleDisplay = async () => {
		store.set('doDisplayStatus', !store.get('doDisplayStatus'));

		const doDisplay = store.get('doDisplayStatus');

		logger.debug(`doDisplayStatus: ${doDisplay}`);
		if (!doDisplay && RPC) await RPC.clearActivity();
	};

	const appBarHide = (doHide) => {
		if (doHide) {
			mainWindow.hide();
			if (process.platform === 'darwin') app.dock.hide();
		} else {
			mainWindow.show();
			if (process.platform === 'darwin') app.dock.show();
		}

		mainWindow.setSkipTaskbar(doHide);
	};

	const loadWindow = (pageName, size, preventAppQuitOnClose = true) => {
		mainWindow.setSize(size.x, size.y);
		mainWindow.loadFile(path.join(__dirname, 'static', `${pageName}.html`));

		if (preventAppQuitOnClose) {
			mainWindow.addListener('close', (closeNoExit = (e) => {
				e.preventDefault(); // prevent app close
				mainWindow.hide(); // hide window
				appBarHide(true);
				mainWindow.removeListener('close', closeNoExit); // remove listener
			}));
		}

		appBarHide(false);
	}

	const stopPresenceUpdater = async () => {
		if (mbc) {
			await mbc.logout();
			mbc = null;
		}
		clearInterval(presenceUpdate);
		presenceUpdate = null;
	};

	const addServer = (server) => {
		if (!tray) return logger.warn('Attempted to add server without tray');

		const servers = store.get('servers');
		servers.push(server);

		store.set('servers', servers);

		tray.setContextMenu(buildTrayMenu(servers));
	};

	const selectServer = async (server) => {
		if (!tray) return logger.warn('Attempted to select server without tray');

		const savedServers = store.get('servers');
		const savedServer = savedServers.find(server => server.isSelected);
		if (savedServer && (server.serverId === savedServer.serverId)) return logger.debug('Tried to select server that\'s already selected');

		const servers = savedServers.map((savedServer) => {
			return savedServer.serverId === server.serverId
				? { ...savedServer, isSelected: true }
				: { ...savedServer, isSelected: false };
		});

		store.set('servers', servers);

		tray.setContextMenu(buildTrayMenu(servers));

		mainWindow.webContents.send('RECEIVE_TYPE', server.serverType);

		await stopPresenceUpdater();
		startPresenceUpdater();
	};

	const removeServer = (serverToRemove) => {
		if (!tray) return logger.warn('Attempted to remove server without tray');

		let wasSelected = false;
		const servers = store
			.get('servers')
			.filter((server) => {
				if (server.serverId !== serverToRemove.serverId) {
					return true;
				} else {
					if (server.isSelected) wasSelected = true;
					return false;
				}
			});

		store.set('servers', servers);

		tray.setContextMenu(buildTrayMenu(servers));

		dialog.showMessageBox({
			title: name,
			type: 'info',
			detail: `Successfully removed server from the server list. ${wasSelected ? 'Since this was the currently selected server, your presence will no longer be displayed.' : ''}`
		});
	};

	const buildTrayMenu = (servers) => {
		const serverSelectionSubmenu = [];

		for (const server of servers) {
			serverSelectionSubmenu.push({
				label: `${server.address} (${server.serverName})`,
				submenu: [
					{
						type: 'normal',
						label: `Selected Server: ${booleanToYN(server.isSelected)}`,
						enabled: false
					},
					{
						label: 'Remove Server',
						click: () => removeServer(server)
					},
					{
						label: 'Select Server',
						click: () => selectServer(server)
					}
				]
			});
		}

		const contextMenu = Menu.buildFromTemplate([
			{
				type: 'checkbox',
				label: 'Run at Startup',
				click: () => startupHandler.toggle(),
				checked: startupHandler.isEnabled
			},
			{
				type: 'checkbox',
				label: 'Display as Status',
				click: () => toggleDisplay(),
				checked: store.get('doDisplayStatus')
			},
			{
				label: 'Use Time Elapsed',
				type: 'checkbox',
				checked: store.get('useTimeElapsed'),
				click: () => {
					const isUsing = store.get('useTimeElapsed');

					store.set({ useTimeElapsed: !isUsing });
				}
			},
			{
				type: 'separator'
			},
			{
				label: 'Add Server',
				click: () => loadWindow('configure', { x: 600, y: 300 })
			},
			{
				label: 'Select Server',
				submenu: serverSelectionSubmenu
			},
			{
				label: 'Set Ignored Libraries',
				click: () => loadWindow('libraryConfiguration', { x: 450, y: 500 })
			},
			{
				type: 'separator'
			},
			{
				label: 'Check for Updates',
				click: () => checkForUpdates(true)
			},
			{
				label: 'Enable Debug Logging',
				type: 'checkbox',
				checked: store.get('enableDebugLogging'),
				click: () => {
					const isEnabled = store.get('enableDebugLogging');

					logger.enableDebugLogging = !isEnabled;
					store.set({ enableDebugLogging: !isEnabled });
				}
			},
			{
				label: 'Show Logs',
				click: () => shell.openPath(logger.logPath)
			},
			{
				label: 'Reset App',
				click: () => resetApp()
			},
			{
				type: 'separator'
			},
			{
				label: 'Restart App',
				click: () => {
					app.quit();
					app.relaunch();
				}
			},
			{
				label: 'Quit',
				role: 'quit'
			},
			{
				type: 'separator'
			},
			{
				type: 'normal',
				label: `${name} v${version}`,
				enabled: false
			}
		]);

		return contextMenu;
	};

	const moveToTray = () => {
		tray = new Tray(path.join(__dirname, 'icons', 'tray.png'));

		const servers = store.get('servers');
		const contextMenu = buildTrayMenu(servers);

		tray.setToolTip(name);
		tray.setContextMenu(contextMenu);

		if (!is.development) new Notification({
			title: `${name} ${version}`,
			icon: path.join(__dirname, 'icons', 'large.png'),
			body: `${name} has been minimized to the tray`
		}).show();

		appBarHide(true);
	};

	const checkForUpdates = (calledFromTray) => {
		checker.checkForUpdate((err, data) => {
			if (err) {
				if (calledFromTray) {
					dialog.showErrorBox(name, 'Failed to check for updates');
				}
				logger.error(err);
				return;
			}

			if (data.pending) {
				if (!calledFromTray) clearInterval(updateChecker);

				dialog.showMessageBox(
					{
						type: 'info',
						buttons: ['Okay', 'Get Latest Version'],
						message: 'A new version is available!',
						detail: `Your version is ${version}. The latest version currently available is ${data.version}`
					},
					(index) => {
						if (index === 1) {
							shell.openExternal(`${homepage}/releases/latest`);
						}
					}
				);
			} else if (calledFromTray) {
				dialog.showMessageBox({
					title: name,
					type: 'info',
					message: 'There are no new versions available to download'
				});
			}
		});
	};

	const disconnectRPC = async () => {
		if (RPC) {
			logger.info('Disconnecting from Discord');
			clearTimeout(connectRPCTimeout);
			RPC.transport.removeAllListeners('close');
			await RPC.clearActivity();
			await RPC.destroy();
			RPC = null;
		}
	};

	const connectRPC = () => {
		return new Promise((resolve) => {
			if (RPC) return logger.warn('Attempted to connect to RPC pipe while already connected');

			const server = getSelectedServer();
			if (!server) return logger.warn('No selected server');

			RPC = new Client({
				clientId: clientIds[server.serverType],
			});
			RPC
				.login()
				.then(resolve)
				.catch(() => {
					logger.error(
						`Failed to connect to Discord. Attempting to reconnect in ${discordConnectRetryMS / 1000
						} seconds`
					);
				});

			RPC.on('close', () => {
				disconnectRPC();

				logger.warn(
					`Discord RPC connection closed. Attempting to reconnect in ${discordConnectRetryMS / 1000
					} seconds`
				);

				connectRPCTimeout = setTimeout(connectRPC, discordConnectRetryMS);
			});

			RPC.on('ready', () => {
				logger.info(`Connected to Discord (Server type: ${server.serverType})`);
			});
		});
	};

	const startPresenceUpdater = async () => {
		const data = getSelectedServer();
		if (!data) return logger.warn('No selected server');

		mbc = new MBClient(data, {
			deviceName: name,
			deviceId: store.get('UUID'),
			deviceVersion: version,
			iconUrl: iconUrl
		});

		logger.debug('Attempting to log into server');
		logger.debug(scrubObject(data, 'username', 'password', 'address'));

		await disconnectRPC();
		await connectRPC();

		try {
			await mbc.login();
		} catch (err) {
			logger.error('Failed to authenticate. Retrying in 30 seconds.');
			logger.error(err);
			setTimeout(startPresenceUpdater, MBConnectRetryMS);
			return;
		}

		setPresence();
		if (!presenceUpdate) presenceUpdate = setInterval(setPresence, presenceUpdateIntervalMS);
	};

	const setPresence = async () => {
		if (!store.get('doDisplayStatus')) return logger.debug('doDisplayStatus disabled, not setting status');

		const data = store.get();
		const server = getSelectedServer();
		if (!server) return logger.warn('No selected server');

		try {
			let sessions;

			try {
				sessions = await mbc.getSessions(maximumSessionInactivity);
			} catch (err) {
				return logger.error(`Failed to get sessions: ${err}`);
			}

			const session = sessions.find(
				(session) =>
					session.NowPlayingItem !== undefined &&
					session.UserName &&
					session.UserName.toLowerCase() === server.username.toLowerCase()
			);

			if (session) {
				const NPItem = session.NowPlayingItem;

				const NPItemLibraryID = await mbc.getItemInternalLibraryId(NPItem.Id);
				// convert
				if (server.ignoredViews.includes(NPItemLibraryID)) {
					// prettier-ignore
					logger.debug(`${NPItem.Name} is in library with ID ${NPItemLibraryID} which is on the ignored library list, will not set status`);
					if (RPC) await RPC.clearActivity();
					return;
				}

				// remove client IP addresses (hopefully this takes care of all of them)
				logger.debug(scrubObject(session, 'RemoteEndPoint'));

				const currentEpochSeconds = new Date().getTime() / 1000;
				const startTimestamp = Math.round(
					currentEpochSeconds -
					Math.round(session.PlayState.PositionTicks / 10000 / 1000)
				);
				const endTimestamp = Math.round(
					currentEpochSeconds +
					Math.round(
						(session.NowPlayingItem.RunTimeTicks -
							session.PlayState.PositionTicks) /
						10000 /
						1000
					)
				);

				logger.debug(
					`Time until media end: ${endTimestamp - currentEpochSeconds
					}, been playing since: ${startTimestamp}`
				);

				setTimeout(
					setPresence,
					(endTimestamp - currentEpochSeconds) * 1000 + 1500
				);

				const defaultProperties = {
					type: NPItem.Type === 'Audio' ? ActivityType.Listening : ActivityType.Watching,
					largeImageKey: 'large',
					largeImageText: `${NPItem.Type === 'Audio' ? 'Listening' : 'Watching'
						} on ${session.Client}`,
					smallImageKey: session.PlayState.IsPaused ? 'pause' : 'play',
					smallImageText: session.PlayState.IsPaused ? 'Paused' : 'Playing',
					instance: false
				};

				if (!session.PlayState.IsPaused) {
					data.useTimeElapsed
						? (defaultProperties.startTimestamp = startTimestamp)
						: (defaultProperties.endTimestamp = endTimestamp);
				}

				switch (NPItem.Type) {
					case 'Episode': {
						// prettier-ignore
						const seasonNum = NPItem.ParentIndexNumber
						// prettier-ignore
						const episodeNum = NPItem.IndexNumber;

						RPC.setActivity({
							details: `Watching ${NPItem.SeriesName} ${NPItem.ProductionYear ? `(${NPItem.ProductionYear})` : ''
								}`,
							state: `${seasonNum ? `S${seasonNum.toString().padStart(2, '0')}` : ''
								}${episodeNum ? `E${episodeNum.toString().padStart(2, '0')}: ` : ''
								}${NPItem.Name}`,
							...defaultProperties
						});
						break;
					}
					case 'Movie': {
						RPC.setActivity({
							details: 'Watching a Movie',
							state: `${NPItem.Name} ${NPItem.ProductionYear ? `(${NPItem.ProductionYear})` : ''
								}`,
							...defaultProperties
						});
						break;
					}
					case 'MusicVideo': {
						const artists = NPItem.Artists.splice(0, 3); // we only want 3 artists

						RPC.setActivity({
							details: `Watching ${NPItem.Name} ${NPItem.ProductionYear ? `(${NPItem.ProductionYear})` : ''
								}`,
							state: `By ${artists.length ? artists.join(', ') : 'Unknown Artist'
								}`,
							...defaultProperties
						});
						break;
					}
					case 'Audio': {
						const artists = NPItem.Artists.splice(0, 3);
						const albumArtists = NPItem.AlbumArtists.map(
							(ArtistInfo) => ArtistInfo.Name
						).splice(0, 3);

						RPC.setActivity({
							details: `Listening to ${NPItem.Name} ${NPItem.ProductionYear ? `(${NPItem.ProductionYear})` : ''
								}`,
							state: `By ${artists.length
								? artists.join(', ')
								: albumArtists.length
									? albumArtists.join(', ')
									: 'Unknown Artist'
								}`,
							...defaultProperties
						});
						break;
					}
					default:
						RPC.setActivity({
							details: 'Watching Other Content',
							state: NPItem.Name,
							...defaultProperties
						});
				}
			} else {
				logger.debug('No session, clearing activity');
				if (RPC) await RPC.clearActivity();
			}
		} catch (error) {
			logger.error(`Failed to set activity: ${error}`);
		}
	};

	ipcMain.on('RECEIVE_INFO', async (event) => {
		let jellyfinServers = [];
		let embyServers = [];

		try {
			jellyfinServers = await serverDiscoveryClient.find(1750, 'jellyfin');
		} catch (err) {
			jellyfinServers = [];
			logger.error('Failed to get Jellyfin servers');
			logger.error(err);
		}

		try {
			embyServers = await serverDiscoveryClient.find(1750, 'emby');
		} catch (err) {
			embyServers = [];
			logger.error('Failed to get Emby servers');
			logger.error(err);
		}

		// TODO: filter out servers that are already saved from showing in autodetect
		const servers = [
			// prettier-ignore
			...embyServers,
			...jellyfinServers
		];

		logger.debug(`Server discovery result: ${JSON.stringify(servers)}`);

		event.reply('RECEIVE_INFO', servers);
	});

	ipcMain.on('VIEW_SAVE', (_, data) => {
		// CONVERT
		const servers = store.get('servers');
		const selectedServer = getSelectedServer();
		const ignoredViews = selectedServer.ignoredViews;

		if (ignoredViews.includes(data)) {
			ignoredViews.splice(ignoredViews.indexOf(data), 1);
		} else {
			ignoredViews.push(data);
		}

		store.set({
			servers: servers.map((server) =>
				server.isSelected ? { ...server, ignoredViews } : server
			)
		});
	});

	ipcMain.on('TYPE_CHANGE', (_, data) => {
		// CONVERT
		switch (data) {
			case 'jellyfin':
				store.set({ serverType: 'jellyfin' });
				break;
			case 'emby':
				store.set({ serverType: 'emby' });
				break;
		}
	});

	ipcMain.on('RECEIVE_VIEWS', async (event) => {
		let userViews;

		if (!mbc.isAuthenticated) {
			// Not authed yet
			logger.info('Attempting to authenticate');
			try {
				await mbc.login();
			} catch (err) {
				event.reply('FETCH_FAILED');
				dialog.showErrorBox(
					name,
					'Failed to fetch libraries for your user. Please try the reload button.'
				);

				logger.error('Failed to authenticate');
				logger.error(err);
			}
		}

		try {
			userViews = await mbc.getUserViews();
		} catch (err) {
			event.reply('FETCH_FAILED');
			dialog.showErrorBox(
				name,
				'Failed to fetch libraries for your user. Please try the reload button.'
			);
			logger.error(err);

			return;
		}

		// convert
		const viewData = {
			availableViews: userViews,
			ignoredViews: getSelectedServer().ignoredViews
		};

		logger.debug('Sending view data to renderer');
		logger.debug(viewData);

		event.reply('RECEIVE_VIEWS', viewData);
	});


	// FUTURE RELEASE, UNDECIDED..
	// ipcMain.on('RECEIVE_CONNECT_SERVERS', async (event, data) => {
	// 	logger.debug(`Receive connect servers data: ${JSON.stringify(data)}`);

	// 	let connectUser;
	// 	try {
	// 		connectUser = await connectAPI.getConnectUser(data.nameOrEmail, data.password);
	// 	} catch (err) {
	// 		logger.error(err);

	// 		let errorMessage;

	// 		if (err.status && err.status === 401) {
	// 			errorMessage = 'Failed to authenticate with connect, no user with that email/name exists';
	// 		} else if (err.status && err.status === 401) {
	// 			errorMessage = 'Failed to authenticate with connect, invalid password provided';
	// 		} else {
	// 			errorMessage = 'Failed to authenticate with connect, an unknown error occured.';
	// 		}

	// 		dialog.showMessageBox(mainWindow, {
	// 			type: 'error',
	// 			title: name,
	// 			detail: errorMessage
	// 		});

	// 		return event.reply('CONNECT_ERROR');
	// 	}

	// 	let connectServers;
	// 	try {
	// 	 	connectServers = await connectAPI.getConnectServers(connectUser.AccessToken, connectUser.User.Id);
	// 	} catch (err) {
	// 		logger.error(err);

	// 		dialog.showMessageBox(mainWindow, {
	// 			type: 'error',
	// 			title: name,
	// 			detail: 'An error occured and we failed to fetch the connect servers linked to your account, please try again later.'
	// 		});

	// 		return event.reply('CONNECT_ERROR');
	// 	}

	// 	event.reply('RECEIVE_CONNECT_SERVERS', connectServers);
	// });

	ipcMain.on('ADD_SERVER', async (event, data) => {
		logger.debug('Is first setup: ' + !store.get('isConfigured'));

		const emptyFields = Object.entries(data)
			.filter((entry) => !entry[1] && entry[0] !== 'password') // where entry[1] is the value, and if the field password is ignore it (emby and jelly dont require you to have a pw, even though you should even on local network)
			.map((field) => field[0]); // we map empty fields by their names

		if (emptyFields.length) {
			mainWindow.webContents.send('VALIDATION_ERROR', emptyFields);
			dialog.showMessageBox(mainWindow, {
				title: name,
				type: 'error',
				detail: 'Please make sure that all the fields are filled in!'
			});
			return;
		}

		let client = new MBClient(data, {
			deviceName: name,
			deviceId: store.get('UUID'),
			deviceVersion: version,
			iconUrl: iconUrl
		});

		logger.debug('Attempting to log into server');
		logger.debug(scrubObject(data, 'username', 'password', 'address'));

		let serverInfo;
		try {
			await client.login();
			serverInfo = await client.getSystemInfo();
		} catch (error) {
			logger.error(error);
			dialog.showMessageBox(mainWindow, {
				type: 'error',
				title: name,
				detail: 'Invalid server address or login credentials'
			});
			event.reply('RESET');
			return;
		}

		if (!store.get('isConfigured')) {
			// convert
			store.set({
				servers: [
					{
						...data,
						isSelected: true,
						ignoredViews: [],
						serverId: serverInfo.Id,
						serverName: serverInfo.ServerName
					}
				],
				isConfigured: true,
				doDisplayStatus: true
			});

			moveToTray();
			startPresenceUpdater();
		} else {
			logger.debug(store.get('servers'));

			const configuredServers = store.get('servers');

			if (
				configuredServers.some(
					(configuredServer) =>
						configuredServer.serverId === serverInfo.Id
				)
			) {
				dialog.showMessageBox(mainWindow, {
					type: 'error',
					title: name,
					detail:
						'You already configured this server, you can enable it from the tray.'
				});

				event.reply('RESET', true);
			} else {
				const newServer = {
					...data,
					isSelected: false,
					ignoredViews: [],
					serverId: serverInfo.Id,
					serverName: serverInfo.ServerName
				};

				mainWindow.hide();

				addServer(newServer);

				if (getSelectedServer()) {
					const res = await dialog.showMessageBox({
						type: 'info',
						title: name,
						message:
							'Your server has been successfully added. Would you like to select it automatically?',
						buttons: ['Yes', 'No']
					});

					if (res.response === 0) {
						selectServer(newServer);
					}
				} else {
					dialog.showMessageBox({
						type: 'info',
						title: name,
						message:
							'Your server has been successfully added and has been automatically selected.'
					});

					selectServer(newServer);
				}

				appBarHide(true);
			}
		}
	});

	ipcMain.on('RECEIVE_TYPE', (event) => {
		const selectedServer = getSelectedServer();
		event.reply(
			'RECEIVE_TYPE',
			selectedServer ? selectedServer.serverType : 'emby'
		);
	});

	if (app.isReady()) {
		startApp();
	} else {
		app.once('ready', startApp);
	}
})();