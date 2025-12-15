update Istio virtual service
```
    - match:
        - uri:
            prefix: /rclone-ui
      route:
        - destination:
            host: rclone-ui.default.svc.cluster.local
            port:
              number: 3000
    - match:
        - uri:
            prefix: /rclone-server
      rewrite:
        uriRegexRewrite:
          match: /rclone-server(/|$)(.*)
          rewrite: /\2
      route:
        - destination:
            host: rclone-server.default.svc.cluster.local
            port:
              number: 8080

```