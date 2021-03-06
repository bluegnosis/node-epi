/**
 * EPI - Enterprise Proxy Integration
 * @author Doug Mealing <doug@bluegnosis.com>
 */
var http = require('http'),
    httpProxy = require('http-proxy'),
    zlib = require('zlib'),
    agent,
    lastDump = '',
    TIMEOUT_INC = 1000,
    TIMEOUT_MAX = 120 * 1000,
    MAX_RETRY = 5;

// Setup a new custom Agent
agent = new http.Agent;
// Set the max sockets much higher (100)
agent.maxSockets=100;

// TODO:  Add support for an Agent per session

// TODO:  Buffer input to disk on uploads (especially if there are long delays on connections)

/**
 * @function Create a Proxy middleware to handle proxy requests
 */
exports.createProxy = function createProxy(port, server, baseUrl, path, templateEngine, before ) {

    var proxyOptions;

    // If the first param is an object, then ignore the others and use that as the proxy options
    if ( typeof port === 'object' ) {
        proxyOptions = port;
        // TODO:  Add some additional checks on proxyOptions
    }
    else {
        proxyOptions = {
            server: server,
            port: port,
            baseUrl: baseUrl,
            path: path,
            templateEngine: templateEngine,
            beforeCallback: before
        };
    }

    return createProxyHandler( proxyOptions );
}

/**
 * @function Create a Proxy handler
 */
function createProxyHandler( proxyOptions ) {

    var handler = function (req, res, next) {

        var proxyOptionsRequest = {
            server: proxyOptions.server,
            port: proxyOptions.port,
            baseUrl: proxyOptions.baseUrl,
            path: proxyOptions.path,
            templateEngine: proxyOptions.templateEngine,
            beforeCallback: proxyOptions.beforeCallback,
            connectTimeout: TIMEOUT_INC,
            retries: 0
        };

        proxyRequest( proxyOptionsRequest, req, res, next );
    }

    return handler;
};

/**
 * @function Perform the proxy proxyRequest
 */
var proxyRequest = function( proxyOptions, req, res, next ) {

    var newPath = req.url;
    if (proxyOptions.baseUrl) {
        newPath = proxyOptions.baseUrl + req.url;
    }

    var headers = {};
    for ( var key in req.headers ) {
        headers[key.toLowerCase()] = req.headers[key];
    }

    headers['host'] = proxyOptions.server + (proxyOptions.port ? ":" + proxyOptions.port : "");
    // headers['accept-encoding'] = '';

    var requestOptions = {
        method: req.method,
        host: proxyOptions.server,
        port: proxyOptions.port,
        path: newPath,
        headers: headers,
        agent: agent
    };

    // Forward any data from the original proxyRequest
    req.on('data', function(chunk){

        if ( !proxyOptions.proxyRequest || !proxyOptions.proxyRequest.isConnected ) {
            // TODO:  Handle when the outBuffer gets too large
            if ( !proxyOptions.outBuffer ) proxyOptions.outBuffer = chunk;
            else proxyOptions.outBuffer += chunk;
        }
        else {
            if ( proxyOptions.outBuffer ) {
                proxyOptions.proxyRequest.write( proxyOptions.outBuffer );
                delete proxyOptions.outBuffer;
            }
            if ( proxyOptions.debug ) console.log( "WROTE: " + chunk );
            proxyOptions.proxyRequest.write( chunk );
        }
    });

    // Close it up
    req.on('end', function() {

        if ( !proxyOptions.proxyRequest || !proxyOptions.proxyRequest.isConnected ) {
            proxyOptions.needToEndRequest = true;
        }
        else {
            // Start reading data from the proxy
            proxyOptions.proxyRequest.end();
        }
    });

    req.pause();

    // If there is a before callback, then execute that
    if ( proxyOptions.beforeCallback ) {
        proxyOptions.beforeCallback( proxyOptions, requestOptions, req, res, function( err ) {
            if ( err ) {
                // TODO:  Just return an error?
            }
            executeProxy( proxyOptions, requestOptions, req, res, next );
        });
    }
    
    // Otherwise execute the query directly
    else {
        executeProxy( proxyOptions, requestOptions, req, res, next );
    }    
}

/**
 * @function Execute the proxy proxyRequest (might get retried)
 */
var executeProxy = function( proxyOptions, requestOptions, req, res, next ) {

    if ( proxyOptions.debug || proxyOptions.retries > 0 ) {
        console.log("PROXY:  host=" + req.headers.host + ", url=" + req.url);
    }

    // Perform the proxied proxyRequest
    var proxyRequest = http.request( requestOptions );
    proxyRequest.isConnected = false;
    proxyOptions.proxyRequest = proxyRequest;  // Used in proxyRequest on data and on end methods

    // Handle the response when it arrives
    proxyRequest.on('response', function(resp) {

        // Copy the response headers
        var resHeaders = {};
        for ( var key in resp.headers ) {
            resHeaders[key.toLowerCase()] = resp.headers[key];
        }

        // If retrying, dump out some details
        if ( proxyOptions.debug || proxyOptions.retries > 0 ) {
            console.log( "RESPONSE ["+resp.statusCode+"/"+resHeaders['content-type']+":"+resHeaders['content-type']+"]: " + JSON.stringify( resHeaders ));
        }

        // If it's text/html then handle it differently
        if ( resp.statusCode === 200 && resHeaders['content-type'].toLowerCase().split(';')[0] === 'text/html' ) {

            var body = '',
                stream = resp,
                gunzip;

            // If the response is compressed, setup a gunzip
            if ( resHeaders['content-encoding'] == 'gzip' ) {
                gunzip = zlib.createGunzip();
                stream = gunzip;
            }
            else if ( resHeaders['content-encoding'] == 'deflate' ) {
                gunzip = zlib.createInflate();
                stream = gunzip;
            }

            // On new data, append to the body
            stream.on('data', function(chunk){
                body += chunk.toString();
            });

            // When done, handle the full body response
            stream.on('end', function() {
                handleBody( proxyOptions, resHeaders, req, res, body );
            });

            // If we need to unzip, then pipe it
            if ( gunzip ) {
                resp.pipe( gunzip );
            }
        }

        // If it's not text/html, then send everything
        else {
            // delete this to force chunked encoding on text..?
//            if ( resHeaders['content-type'] && resHeaders['content-type'].indexOf('text')==0) {
//                delete resHeaders['content-length'];
//            }
            res.writeHead( resp.statusCode, resHeaders );

            resp.on('data', function(chunk){
                res.write( chunk );
            });

            resp.on('end', function() {
                res.end();
            });
        }

    }).on("error", function(e){

            console.log("Got error on [http://"+proxyOptions.server+":"+proxyOptions.port+req.url+ "] -- " + e.message);

            // If we timed out, let's increase the timeout increment
            if ( proxyRequest.timedOut ) {
                proxyOptions.connectTimeout += TIMEOUT_INC;
            }

            // If we haven't exceed the max retries, let's try to proxy it again
            if ( proxyOptions.retries < MAX_RETRY && !proxyRequest.isConnected ) {
                proxyOptions.retries++;
                console.log( "RETRY #"+proxyOptions.retries+" on [http://"+proxyOptions.server+":"+proxyOptions.port+req.url+ "]");
                executeProxy( proxyOptions, requestOptions, req, res, next );
            }

            // If we are done retrying, then send a failure
            else {
                res.writeHead( 504 );
                res.end();
            }
        });

    // Set the timeout to be false (in case requests are pooled)
    proxyRequest.timedOut = false;

    // Handle shorter timeouts
    proxyRequest.on('socket', function(socket){

        proxyRequest.socket = socket;

        socket.setTimeout( proxyOptions.connectTimeout );

        socket.on('connect', function() {

            proxyRequest.isConnected = true;

            if ( proxyOptions.debug ) console.log( "Connected to [http://"+proxyOptions.server+":"+proxyOptions.port+req.url+ "]" )

            // Set the timeout to 2 minutes
            socket.setTimeout( 120*1000 );

            // If there is data to write, then write it
            if ( proxyOptions.outBuffer ) {
                if ( proxyOptions.debug ) console.log( ">> Writing outBuffer: ["+proxyOptions.outBuffer+"]" );
                proxyRequest.write( proxyOptions.outBuffer );
                delete proxyOptions.outBuffer;
            }

            // End the proxyRequest if that event was already called
            if ( proxyOptions.needToEndRequest ) {
                if ( proxyOptions.debug ) console.log( ">> needToEndRequest=true, ending request" );
                proxyRequest.end();
            }

            // Resume retrieving events
            req.resume();
        });

        socket.on('timeout', function() {

            if ( !proxyRequest.isConnected ) {

                // Only abort if still trying to connect
                proxyRequest.abort();
                proxyRequest.timedOut = true;

                // Send a retry?
                console.log( "WARN: Socket connection timeout on  [http://"+proxyOptions.server+":"+proxyOptions.port+req.url+ "]");
            }
        });
    });
};

/**
 * @function Handle a text/html body
 */
function handleBody( proxyOptions, resHeaders, req, res, body ) {

    if ( proxyOptions.debug ) console.log( "Handling body" );

    //body = body.replace( new RegExp('href="~?/'+proxyOptions.baseUrl,'g'), 'href="'+proxyOptions.path+'/' );
    //body = body.replace( new RegExp('src="~?/'+proxyOptions.baseUrl,'g'), 'src="'+proxyOptions.path+'/' );

    if ( proxyOptions.templateEngine && body.slice(0,1) != '{' ) {
        body = proxyOptions.templateEngine(req,'thick','header')
            + body
            + proxyOptions.templateEngine(req,'thick','footer');
    }

    // Write the data to the response
    resHeaders['content-type'] = 'text/html';
    // delete this as it's not accurate and it forces chunked encoding
    delete resHeaders['content-length']; // = body.length;
    res.writeHead( 200, resHeaders );

    // If we are compressing, then compress the body
    if ( resHeaders['content-encoding'] === 'gzip' ) {

        zlib.gzip( body, function( err, buffer ) {
            writeBody( res, buffer );
        });
    }
    else if ( resHeaders['content-encoding'] === 'deflate' ) {

        zlib.deflate( body, function( err, buffer ) {
            writeBody( res, buffer );
        });
    }
    // If no compression, then just write it directly
    else {
        writeBody( res, body );
    }
}

function writeBody( res, body ) {
    res.write( body );
    res.end();
}

//function dumpAgent() {
//
//    var dump = '',
//        sockets,
//        requests;
//
//    for( var m in agent.sockets ) {
//
//        sockets = (agent.sockets[m]?agent.sockets[m].length:0),
//        requests = (agent.requests[m]?agent.requests[m].length:0);
//
//        dump += "AGENT ["+m+"]"
//            + " sockets:" + sockets
//            + ", queue:" + requests
//            + "\n";
//
//        agent.sockets[m].forEach( function( s ) {
//           dump += "Socket ["+ s._httpMessage.path+"]:"
//               +" bytesRead="+ s.bytesRead
//               +", _connecting="+ s._connecting
//               +", _headerSent="+ s._httpMessage._headerSent
//               +"\n";
//        });
//    }
//
//    if ( dump === '') dump = "EPI - No sockets found";
//
//    if ( dump != lastDump ) {
//        console.log( dump );
//        lastDump = dump;
//    }
//}
//
//setInterval( dumpAgent, 100 );
