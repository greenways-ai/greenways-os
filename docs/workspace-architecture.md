# Workspace architecture

```text
Flutter renderer
  ↕ bounded view models and UI events
Desktop Rust companion
  ↕ persistent local connection
installed daemon service
  ↕
persistent semantic replica
```

Chats is the first complete slice. Delivery order is contracts, runtime prerequisite, storage prerequisite, daemon, Desktop, then integration. Failed gates block later merges.
