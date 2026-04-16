server {
listen 80;
server_name 你的域名.com; # 先用域名，后面配 SSL

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;

        # 微信小程序超时问题：调大超时时间
        proxy_read_timeout 120s;
        proxy_connect_timeout 30s;
    }

}
