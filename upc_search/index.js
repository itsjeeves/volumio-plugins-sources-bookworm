'use strict';

var libQ = require('kew');
var fs=require('fs-extra');
var config = new (require('v-conf'))();
var exec = require('child_process').exec;
var execSync = require('child_process').execSync;

var FuzzySearch = require('fuzzy-search');
var Discogs = require('disconnect').Client;

const io = require('socket.io-client');
var endpoint_data = {
		'endpoint': 'user_interface/upc_search',
		'type': 'user_interface',
		'name': 'upc_search',
		//'method': 'searchAlbumArtist',
	};

/*
https://community.volumio.com/t/finding-debugging-logs/58698
https://developers.volumio.com/plugins/uiconfig-json
https://github.com/volumio/volumio-plugins-sources/tree/master
*/

/*
02521800022  // CCR - Chronicle // subdivide
602475490067 // TPHB - TPHB // artist == title
731452141422 // Getz/Gilberto // whitespace mismatches in spotify
4577871122 // Jolie Holland + TGS // spop short artist (presubdivide)

*/

module.exports = upcSearch;
function upcSearch(context) {
	var self = this;

	self.context = context;
	self.commandRouter = self.context.coreCommand;
	self.logger = self.context.logger;
	self.configManager = self.context.configManager;

	self.logger.transports[0].level = 'debug';
}



upcSearch.prototype.onVolumioStart = function()
{
	var self = this;
	var configFile=this.commandRouter.pluginManager.getConfigurationFile(this.context,'config.json');
	this.config = new (require('v-conf'))();
	this.config.loadFile(configFile);

    return libQ.resolve();
}

upcSearch.prototype.onStart = function() {
    var self = this;
	var defer=libQ.defer();

	self.socket = io.connect('http://localhost:3000');
	/*
	self.socket.emit('getState');
	self.socket.on('pushState',function(data){
		self.logger.debug("UPC_SEARCH::onStart got pushState: " + JSON.stringify(data));
	});
	*/
	
	//endpoint_data.method = 'searchAlbumArtist',
	//self.commandRouter.addPluginRestEndpoint(endpoint_data);
	endpoint_data.method = 'searchUPC',
	self.commandRouter.addPluginRestEndpoint(endpoint_data);
	
	self.discogs_token = self.config.get('token');//'GVvZiRVYsDgFKLPdMzITQmkuiZEoEjHUmfEuXxxX';
	
	self.db = new Discogs('VolumioUPCSearch/1.0', {userToken: self.discogs_token}).database();
	/*
	var testRelease = 176126;
	testRelease = 11500690;
	self.db.getRelease(testRelease, function(err, data) {
		self.logger.debug("Data for release " + testRelease + ": " + JSON.stringify(data));
	});
	*/

	// Once the Plugin has successfully started resolve the promise
	defer.resolve();

    return defer.promise;
};

upcSearch.prototype.onStop = function() {
    var self = this;
    var defer=libQ.defer();
	
	self.commandRouter.removePluginRestEndpoint(endpoint_data);

	self.logger.debug("UPC_SEARCH::onStop disconnecting from socket")
	self.socket.disconnect();

    // Once the Plugin has successfully stopped resolve the promise
    defer.resolve();

    return libQ.resolve();
};

upcSearch.prototype.subdivideString = function(data) {
    var self = this;
	self.logger.debug("UPC_SEARCH::subdivideString attempting to shorten " + data);
    if (data.length > 5) {
	
		const seperators = ":-;_=|({[&"
		for (const sep of seperators) {
			var idx = data.indexOf(sep);
			if (idx >= 4){
				self.logger.debug("UPC_SEARCH::subdivideString found separator " + sep + " at " + idx);
				data = data.substring(0, idx-1)
				break;
			}
		}
	}
	
	self.logger.debug("UPC_SEARCH::subdivideString results " + data);
	/*
	// no obvious separators, try halving the string
	var end = Math.floor(data.length / 2)
	data = data.substring(0, end)
	return data
	*/
	return data;
};


// Plugin Logic --------------------------------------------------------------------------------------

upcSearch.prototype.onRestart = function() {
    var self = this;
    // Optional, use if you need it
};


upcSearch.prototype.setDiscogsToken = function(data) {
	var self = this;
	
	self.discogs_token = data.token;
	if (self.discogs_token !== "") {
		self.db = new Discogs('VolumioUPCSearch/1.0', {userToken: self.discogs_token}).database();
		
		self.db.search({barcode: '0 7863-56784-1',type: 'release'}).then(function(results){
			self.commandRouter.pushToastMessage('success', "Discogs Token", "Token applied successfully");
		}).catch(function(err) {
			self.logger.error("UPC_SEARCH::setDiscogsToken error: " + JSON.stringify(err));
			self.commandRouter.pushToastMessage('error', "Discogs Token", "Token was invalid! " + JSON.stringify(err));
		});
	
		self.logger.info("UPC_SEARCH::setDiscogsToken updated to " + self.discogs_token);
	} else {
		self.logger.info("UPC_SEARCH::setDiscogsToken was un-set.");
	}
	
	self.config.set('token', self.discogs_token);
};

upcSearch.prototype.setOptions = function(data) {
	var self = this;
	
	self.logger.info("UPC_SEARCH::setOptions :" + JSON.stringify(data));
	
	self.config.set('behavior', data['onSearch']['value']);
};

upcSearch.prototype.updateFromMasterID = function(){
	var self = this;
	
	self.logger.debug("UPC_SEARCH::updateFromMasterID");
	
	if (self.master_id) {
		self.logger.debug("UPC_SEARCH::updateFromMasterID " + self.master_id)
		self.db.getMaster(self.master_id, function(err, master) {
			
			if (master.title && !self.artist) {
				self.album = master.title;
			}
			
			if (master.artists.length >= 1) {
				var artist = master.artists[0].name;
				if (self.artist !== artist) {
					self.artist = artist;
					// handle artist disambiguators (https://support.discogs.com/hc/en-us/articles/360005054753-Database-Guidelines-2-Artist#2.4.1)
					self.artist = self.artist.replace(/\([0-9]+\)/, "");
					self.logger.debug("UPC_SEARCH::updateFromMasterID artist name: " + self.artist);
					
					self.album = master.title ? master.title : self.album;
				}
			}
			
			
			if (self.album && self.artist) {
				self.logger.debug("UPC_SEARCH::updateFromMasterID would have played master_id")
				// pre-subdivide
				var new_artist = self.subdivideString(self.artist);
				var new_album = self.subdivideString(self.album);
				self.searchAlbumArtist({album: new_album, artist: new_artist, service: 'all'});		
			}
		});
	} else {
		if (self.album && self.artist) {
			self.logger.debug("UPC_SEARCH::updateFromMasterID would have played else")
			// pre-subdivide
			var new_artist = self.subdivideString(self.artist);
			var new_album = self.subdivideString(self.album);
			self.searchAlbumArtist({album: new_album, artist: new_artist, service: 'all'});		
		} else {
			// didn't find any UPC results.  See if there's a known problem-causing prefix (scanner in numeric, not alphanumeric, mode?)
			if (self.upc.substring(0,2) === "20") {
				var transformed_upc = {
					upc: "D" + self.upc.substring(2)
				};
				self.searchUPC(transformed_upc);
			}
		}
	}
};

upcSearch.prototype.handleUPCData = function(data) {
	var self = this;
	
	self.logger.debug("UPC_SEARCH::handleUPCData " + JSON.stringify(data));
	
	for (let i = 0; i < data.results.length; i++) {
		if (data.results[i].title) {
			self.album = data.results[i].title;
			var separator = self.album.indexOf("-");
			if (separator !== -1) {
				self.artist = self.album.substring(0,separator);
				self.album = self.album.substring(separator+2);
				
				// handle artist disambiguators (https://support.discogs.com/hc/en-us/articles/360005054753-Database-Guidelines-2-Artist#2.4.1)
				self.artist = self.artist.replace(/\([0-9]+\)/, "");
				self.logger.debug("UPC_SEARCH::handleUPCData artist name: " + self.artist);
				
			}
		}
		
		if (data.results[i].master_id) {
			self.master_id = data.results[i].master_id;
			break;
		}
	}
};

upcSearch.prototype.searchUPC = function(data) {
	var self = this;
	
	var defer = libQ.defer();
	
	if (self.discogs_token === "") {
		
		self.logger.error("UPC_SEARCH::searchUPC requires setting discogs token");
		defer.reject(new Error());
		return defer.promise;
	};
	
	self.logger.debug("UPC_SEARCH::searchUPC data: " + JSON.stringify(data));
	
	//var query = "";//data.upc;
	var params = {
		barcode: data.upc,
		type: 'release'
	};
	
	if ("action" in data) {
		self.config.set('behavior', parseInt(data.action))
	}
	
	self.logger.debug("UPC_SEARCH::searchUPC params: " + JSON.stringify(params));
	
	self.upc = data.upc;
	self.artist = null;
	self.album = null;
	self.master_id = null;
	self.full_results = null;
	
	var releaseInfo = {
		'artist': null,
		'album': null
	};
	
	self.db.search(params)
			.then(function(results){
				self.handleUPCData(results);
			}).then(function() {
				self.updateFromMasterID();
				releaseInfo.artist = self.artist
				releaseInfo.album = self.album
				defer.resolve(releaseInfo)
			}).catch(function(err) {
				self.logger.error("UPC_SEARCH::searchUPC error: " + JSON.stringify(err));
				defer.reject(new Error());
			});
			
	return defer.promise;
};

upcSearch.prototype.searchAlbumArtist = function(state) {
	var self = this;
	
	self.logger.debug("UPC_SEARCH::searchAlbumArtist got state:")
	self.logger.debug(JSON.stringify(state));
	
	if (state.artist) {
		state.artist = state.artist.toLowerCase();
		state.artist = state.artist.replace(" trio", "");
		state.artist = state.artist.replace(" quartet", "");
		state.artist = state.artist.replace(" quintet", "");
		state.artist = state.artist.replace(" sextet", "");
		state.artist = state.artist.replace(" octet", "");
		
		if (state.artist.substring(0,4) === "the " && state.artist.length > 6) {
			state.artist = state.artist.substring(4);
		}
	}
	if (state.album) state.album = state.album.toLowerCase();
	
	self.artist = state.artist;
	self.album = state.album;
	
	var search_val = state.album;
	if (state.artist && state.artist.length >= 1) {
		search_val = state.artist + " " + search_val;
	}
	var search_data = { 'value':search_val };
	if (state.service && state.service !== 'all') {
		search_data.service = state.service
	}
	
	self.search_state = state;
	self.search_state['search_val'] = search_val;
	
	self.logger.debug("UPC_SEARCH::searchAlbumArtist emitting 'search' with data:\n\t" + JSON.stringify(search_data));
	
	
	self.socket.emit("search", search_data);
	self.socket.once("pushBrowseLibrary", function(data) {
		self.logger.debug("Response!");
		self.onSearchResults(data);
		});
};

upcSearch.prototype.onSearchResults = function(data) {
	var self = this;
	
	self.logger.debug("UPC_SEARCH::onSearchResults got data")
	
	function extractAlbumsFromJSON(obj, albums, target_key) {
		for (let key in obj) {
			if (typeof obj[key] === 'object') {
				if (Array.isArray(obj[key])) {
					// loop through array
					for (let i = 0; i < obj[key].length; i++) {
						albums = extractAlbumsFromJSON(obj[key][i], albums, target_key);
					}
				} else {
					// recurse
					albums = extractAlbumsFromJSON(obj[key], albums, target_key);
				}
			} else {
				//extract?
				if (key === target_key) {
					albums.push(obj);
				}
			}
		}
		
		return albums;
	}
	
	var target_key = 'uri';
	var albums = extractAlbumsFromJSON(data, [], target_key);
	
	albums = albums.filter(function (el) {
		return el.uri.indexOf("spotify:artist") === -1 &&
			   el.uri.indexOf("artists://") === -1 &&
			   el.type.indexOf("folder") === 0 &&
			   el.title.length > 0;
	});
	
	self.logger.debug("UPC_SEARCH::onSearchResults extracted raw albums:");
	for (let i = 0; i < albums.length; i++) {
		self.logger.debug("\t" + JSON.stringify(albums[i]));
		
		
		// sanitize things a little bit
		if (albums[i].title) {
			albums[i].title = albums[i].title.replace("…", "...");
			albums[i].title = albums[i].title.toLowerCase();
		}
		
		if (albums[i].artist) {
			albums[i].artist = albums[i].artist.toLowerCase();
		}
	
		
		albums[i].artist_album = albums[i].artist + " " + albums[i].title;
	}
	
	var local_albums = albums.filter(function (el) {
		return el.service.indexOf("mpd") === 0;
	});
	
	self.logger.debug("UPC_SEARCH::onSearchResults local albums: ")
	for (let i = 0; i < local_albums.length; i++) {
		//local_albums[i].artist_album = local_albums[i].artist + " " + local_albums[i].title
		self.logger.debug("\t" + JSON.stringify(local_albums[i]));
	}
	
	if (local_albums.length == 0) {
		self.logger.debug("\tNone!");
	
		if (!self.full_results) {
			// we haven't subdivided yet
			var service = 'all'
			if (albums.length > 0) {
				service = 'mpd';
				self.full_results = albums;
			}
			
			var new_artist = self.subdivideString(self.artist);
			var new_album = self.subdivideString(self.album);
			if (new_artist !== self.artist || new_album !== self.album) {
				self.artist = new_artist;
				self.album = new_album;
				self.searchAlbumArtist({album: self.album, artist: self.artist, service: service});
				return;
			}
		}
		
		// if we're here:
		//	- there were no local albums
		//  - we've already subdivided and still didn't get any hits OR there's no subdividing to do
		// so:
		//  - fall back to all results if possible
		albums = self.full_results;
	
	//} else {
	//	albums = local_albums;
	} else {
		var perfect_local_albums = local_albums.filter(function (el) {
			return el.artist_album === self.search_state.search_val;
		});
		
		if (perfect_local_albums.length >= 1) {
			self.logger.debug("UPC_SEARCH::onSearchResults found local perfect match");
			albums = perfect_local_albums;
		} else {
			self.logger.debug("UPC_SEARCH::onSearchResults found local match(es)");
			
			perfect_local_albums = local_albums.filter(function (el) {
				return el.title === self.album;
			});
			
			if (perfect_local_albums.length >= 1) {
				self.logger.debug("UPC_SEARCH::onSearchResults found perfect title match");
				albums = perfect_local_albums;
			} else {
				self.logger.debug("UPC_SEARCH::onSearchResults relaxing perfect title match");
				
				perfect_local_albums = local_albums.filter(function (el) {
					var el_title = el.title.replace(/\s/g, "");
					var search_title = self.album.replace(/\s/g, "");
					if (el_title.length > search_title.length) {
						el_title = self.subdivideString(el_title);
					} else {
						search_title = self.subdivideString(search_title);
					}
					
					return el_title === search_title;
				});
				
				if (perfect_local_albums.length >= 1) {
					self.logger.debug("UPC_SEARCH::onSearchResults found relaxed title match");
					albums = perfect_local_albums;
				}
			}
		}
	}
	
	var raw_albums = [];
	for (let i = 0; i < albums.length; i++) {
		var raw_album = albums[i];
		
		if (raw_album.artist_album) {
			raw_album.artist_album = raw_album.artist_album.replace(/\s/g, "");
		}
		
		raw_albums.push(raw_album);
	}
	
	self.logger.debug("UPC_SEARCH::onSearchResults extracted albums:");
	var found_one = false
	for (let i = 0; i < albums.length; i++) {
		self.logger.debug("\t" + JSON.stringify(albums[i]));
		found_one = true
	}
	
	const searcher = new FuzzySearch(raw_albums, ['artist_album'], {'caseSensitive':false, 'sort':true})
	const result = searcher.search(self.search_state.search_val.replace(/\s/g, ""))
	self.logger.debug("UPC_SEARCH::onSearchResults chose final result: " + JSON.stringify(result));
	if (result.length > 0) {
		albums = result
	}
	
	if (found_one) {
		switch(self.config.get('behavior')) {
			case 1:
				self.socket.emit("replaceAndPlay", {service:albums[0].service, uri:albums[0].uri})
				break;
			case 2:
				self.socket.emit("addToQueue", {service:albums[0].service, uri:albums[0].uri})
				break;
			case 3:
				self.commandRouter.pushToastMessage('success', "Found entry", albums[0].service + " " + self.search_state['search_val']);
				//self.commandRouter.pushToastMessage('error', "Discogs Token", "Token was invalid! " + JSON.stringify(err));
				break;
		}
		
		self.artist = null;
		self.album = null;
		self.master_id = null;
		self.full_results = null;
	} 
	/*else {
		self.full_results = albums;
		self.logger.debug("UPC_SEARCH::onSearchResults found nothing!")
		
		self.logger.debug("UPC_SEARCH::onSearchResults attempting subdivision of search terms")
		self.logger.debug(self.artist)
		self.artist = self.subdivideString(self.artist)
		self.logger.debug(self.artist)
		
		self.logger.debug(self.album)
		self.album = self.subdivideString(self.album)
		self.logger.debug(self.album)
		
		if (self.album.length > 0 && self.artist.length > 0) {
			self.searchAlbumArtist({album: self.album, artist: self.artist, service: 'mpd'});
		} else {
			self.logger.debug("UPC_SEARCH::onSearchResults can't subdivide");
		
			self.artist = null;
			self.album = null;
			self.master_id = null;
		}
	}
	*/
};


// Configuration Methods -----------------------------------------------------------------------------

upcSearch.prototype.getUIConfig = function() {
    var defer = libQ.defer();
    var self = this;

    var lang_code = this.commandRouter.sharedVars.get('language_code');

    self.commandRouter.i18nJson(__dirname+'/i18n/strings_'+lang_code+'.json',
        __dirname+'/i18n/strings_en.json',
        __dirname + '/UIConfig.json')
        .then(function(uiconf)
        {	
			
			var findOption = function (optionVal, options) {
                for (var i = 0; i < options.length; i++) {
                    if (options[i].value === optionVal)
                        return options[i];
                }
            };
			
			uiconf.sections[0].content[0].value = self.config.get('token');
			uiconf.sections[1].content[0].value = findOption(self.config.get('behavior'), uiconf.sections[1].content[0].options);
			
            defer.resolve(uiconf);
        })
        .fail(function()
        {
            defer.reject(new Error());
        });

    return defer.promise;
};

upcSearch.prototype.getConfigurationFiles = function() {
	return ['config.json'];
}

upcSearch.prototype.setUIConfig = function(data) {
	var self = this;
	//Perform your installation tasks here
};

upcSearch.prototype.getConf = function(varName) {
	var self = this;
	//Perform your installation tasks here
};

upcSearch.prototype.setConf = function(varName, varValue) {
	var self = this;
	//Perform your installation tasks here
};



// Playback Controls ---------------------------------------------------------------------------------------
// If your plugin is not a music_sevice don't use this part and delete it
/*

upcSearch.prototype.addToBrowseSources = function () {

	// Use this function to add your music service plugin to music sources
    //var data = {name: 'Spotify', uri: 'spotify',plugin_type:'music_service',plugin_name:'spop'};
    this.commandRouter.volumioAddToBrowseSources(data);
};

upcSearch.prototype.handleBrowseUri = function (curUri) {
    var self = this;

    //self.commandRouter.logger.info(curUri);
    var response;


    return response;
};



// Define a method to clear, add, and play an array of tracks
upcSearch.prototype.clearAddPlayTrack = function(track) {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'upcSearch::clearAddPlayTrack');

	self.commandRouter.logger.info(JSON.stringify(track));

	return self.sendSpopCommand('uplay', [track.uri]);
};

upcSearch.prototype.seek = function (timepos) {
    this.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'upcSearch::seek to ' + timepos);

    return this.sendSpopCommand('seek '+timepos, []);
};

// Stop
upcSearch.prototype.stop = function() {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'upcSearch::stop');


};

// Spop pause
upcSearch.prototype.pause = function() {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'upcSearch::pause');


};

// Get state
upcSearch.prototype.getState = function() {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'upcSearch::getState');


};

//Parse state
upcSearch.prototype.parseState = function(sState) {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'upcSearch::parseState');

	//Use this method to parse the state and eventually send it with the following function
};

// Announce updated State
upcSearch.prototype.pushState = function(state) {
	var self = this;
	self.commandRouter.pushConsoleMessage('[' + Date.now() + '] ' + 'upcSearch::pushState');

	return self.commandRouter.servicePushState(state, self.servicename);
};


upcSearch.prototype.explodeUri = function(uri) {
	var self = this;
	var defer=libQ.defer();

	// Mandatory: retrieve all info for a given URI

	return defer.promise;
};

upcSearch.prototype.getAlbumArt = function (data, path) {

	var artist, album;

	if (data != undefined && data.path != undefined) {
		path = data.path;
	}

	var web;

	if (data != undefined && data.artist != undefined) {
		artist = data.artist;
		if (data.album != undefined)
			album = data.album;
		else album = data.artist;

		web = '?web=' + nodetools.urlEncode(artist) + '/' + nodetools.urlEncode(album) + '/large'
	}

	var url = '/albumart';

	if (web != undefined)
		url = url + web;

	if (web != undefined && path != undefined)
		url = url + '&';
	else if (path != undefined)
		url = url + '?';

	if (path != undefined)
		url = url + 'path=' + nodetools.urlEncode(path);

	return url;
};





upcSearch.prototype.search = function (query) {
	var self=this;
	var defer=libQ.defer();

	// Mandatory, search. You can divide the search in sections using following functions

	return defer.promise;
};

upcSearch.prototype._searchArtists = function (results) {

};

upcSearch.prototype._searchAlbums = function (results) {

};

upcSearch.prototype._searchPlaylists = function (results) {


};

upcSearch.prototype._searchTracks = function (results) {

};

upcSearch.prototype.goto=function(data){
    var self=this
    var defer=libQ.defer()

// Handle go to artist and go to album function

     return defer.promise;
};
*/
