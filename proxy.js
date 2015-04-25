try{
    GLOBAL.util = require('./lib/util');
}catch(e){}

var http = require('http'),
    https           = require('https'),
    fs              = require('fs'),
    async           = require("async"),
    url             = require('url'),
    program         = require('commander'),
    color           = require('colorful'),
    certMgr         = require("./lib/certMgr"),
    getPort         = require("./lib/getPort"),
    requestHandler  = require("./lib/requestHandler"),
    Recorder        = require("./lib/recorder"),
    logUtil         = require("./lib/log"),
    wsServer        = require("./lib/wsServer"),
    webInterface    = require("./lib/webInterface"),
    inherits        = require("util").inherits,
    util            = require("./lib/util"),
    path            = require("path"),
    juicer          = require('juicer'),
    events          = require("events"),
    express         = require("express"),
    ip              = require("ip"),
    ent             = require("ent"),
    ThrottleGroup   = require("stream-throttle").ThrottleGroup,
    iconv           = require('iconv-lite'),
    Buffer          = require('buffer').Buffer;


var T_TYPE_HTTP            = 0,
    T_TYPE_HTTPS           = 1,
    DEFAULT_PORT           = 8001,
    DEFAULT_WEB_PORT       = 8002, // port for web interface
    DEFAULT_WEBSOCKET_PORT = 8003, // internal web socket for web interface, not for end users
    DEFAULT_CONFIG_PORT    = 8088,
    DEFAULT_HOST           = "localhost",
    DEFAULT_TYPE           = T_TYPE_HTTP;

var default_rule = require('./lib/rule_default');

//may be unreliable in windows
try{
    var anyproxyHome = path.join(util.getUserHome(),"/.anyproxy/");
    if(!fs.existsSync(anyproxyHome)){
        fs.mkdirSync(anyproxyHome);
    }
    if(fs.existsSync(path.join(anyproxyHome,"rule_default.js"))){
        default_rule = require(path.join(anyproxyHome,"rule_default"));
    }
    if(fs.existsSync(path.join(process.cwd(),'rule.js'))){
        default_rule = require(path.join(process.cwd(),'rule'));
    }
}catch(e){
    if(e){
        logUtil.printLog("error" + e, logUtil.T_ERR);
        throw e;
    }
}

//option
//option.type     : 'http'(default) or 'https'
//option.port     : 8001(default)
//option.hostname : localhost(default)
//option.rule          : ruleModule
//option.webPort       : 8002(default)
//option.socketPort    : 8003(default)
//option.webConfigPort : 8088(default)
//option.dbFile        : null(default)
//option.throttle      : null(default)
//option.disableWebInterface
//option.silent        : false(default)
//option.interceptHttps ,internal param for https
function proxyServer(option){
    option = option || {};

    var self       = this,
        proxyType           = /https/i.test(option.type || DEFAULT_TYPE) ? T_TYPE_HTTPS : T_TYPE_HTTP ,
        proxyPort           = option.port     || DEFAULT_PORT,
        proxyHost           = option.hostname || DEFAULT_HOST,
        proxyRules          = option.rule     || default_rule,
        proxyWebPort        = option.webPort       || DEFAULT_WEB_PORT,       //port for web interface
        socketPort          = option.socketPort    || DEFAULT_WEBSOCKET_PORT, //port for websocket
        proxyConfigPort     = option.webConfigPort || DEFAULT_CONFIG_PORT,    //port to ui config server
        disableWebInterface = !!option.disableWebInterface,
        ifSilent            = !!option.silent,
        webServerInstance;

    if(ifSilent){
        logUtil.setPrintStatus(false);
    }

    if(option.dbFile){
        GLOBAL.recorder = new Recorder({filename: option.dbFile});
    }else{
        GLOBAL.recorder = new Recorder();
    }

    if(!!option.interceptHttps){
        default_rule.setInterceptFlag(true);
    }

    if(option.throttle){
        logUtil.printLog("throttle :" + option.throttle + "kb/s");
        GLOBAL._throttle = new ThrottleGroup({rate: 1024 * parseInt(option.throttle) }); // rate - byte/sec
    }

    requestHandler.setRules(proxyRules); //TODO : optimize calling for set rule
    self.httpProxyServer = null;

    async.series(
        [
            //creat proxy server
            function(callback){
                if(proxyType == T_TYPE_HTTPS){
                    certMgr.getCertificate(proxyHost,function(err,keyContent,crtContent){
                        if(err){
                            callback(err);
                        }else{
                            self.httpProxyServer = https.createServer({
                                key : keyContent,
                                cert: crtContent
                            },requestHandler.userRequestHandler);
                            callback(null);
                        }
                    });
                }else{
                    self.httpProxyServer = http.createServer(requestHandler.userRequestHandler);
                    callback(null);
                }
            },

            //handle CONNECT request for https over http
            function(callback){
                self.httpProxyServer.on('connect',requestHandler.connectReqHandler);
                callback(null);
            },

            //start proxy server
            function(callback){
                self.httpProxyServer.listen(proxyPort);
                callback(null);
            },

            //start web socket service
            function(callback){
                var ws = new wsServer({port : socketPort});
                callback(null)
            },

            //start web interface
            function(callback){
                if(disableWebInterface){
                    logUtil.printLog('web interface is disabled');
                }else{
                    var config = {
                        port         : proxyWebPort,
                        wsPort       : socketPort,
                        ruleSummaery : requestHandler.getRuleSummary(),
                        ip           : ip.address()
                    };

                    webServerInstance = new webInterface(config);
                }
                callback(null);
            },

            //server status manager
            function(callback){

                //kill web server when father process exits
                process.on("exit",function(code){
                    logUtil.printLog('AnyProxy is about to exit with code: ' + code, logUtil.T_ERR);
                    process.exit();
                });

                process.on("uncaughtException",function(err){
                    logUtil.printLog('Caught exception: ' + err, logUtil.T_ERR);
                    process.exit();
                });

                callback(null);
            }
        ],

        //final callback
        function(err,result){
            if(!err){
                var webTip,webUrl;
                webUrl = "http://" + ip.address() + ":" + proxyWebPort +"/";
                webTip = "GUI interface started at : " + webUrl;
                logUtil.printLog(color.green(webTip));

                var tipText = (proxyType == T_TYPE_HTTP ? "Http" : "Https") + " proxy started at " + color.bold(ip.address() + ":" + proxyPort);
                logUtil.printLog(color.green(tipText));
            }else{
                var tipText = "err when start proxy server :(";
                logUtil.printLog(color.red(tipText), logUtil.T_ERR);
                logUtil.printLog(err, logUtil.T_ERR);
            }
        }
    );

    self.close = function(){
        self.httpProxyServer && self.httpProxyServer.close();
        logUtil.printLog(color.green("server closed :" + proxyHost + ":" + proxyPort));
    }
}

module.exports.proxyServer        = proxyServer;
module.exports.generateRootCA     = certMgr.generateRootCA;
module.exports.isRootCAFileExists = certMgr.isRootCAFileExists;
