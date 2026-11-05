# A variable upstream re-resolves Docker DNS after API replacement. Strip the prefix explicitly.
set $ageniza_api http://api:3001;
rewrite ^/api/(.*)$ /$1 break;
proxy_pass $ageniza_api;
proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_set_header Host $host;
proxy_set_header X-Forwarded-Proto https;
proxy_set_header X-Forwarded-For $ageniza_client_ip;
proxy_set_header X-Request-Id $http_x_request_id;
proxy_connect_timeout 5s;
proxy_read_timeout 30s;
