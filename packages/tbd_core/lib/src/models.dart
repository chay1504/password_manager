import 'dart:convert';

class VaultEntry {
  const VaultEntry({
    required this.id,
    required this.name,
    required this.site,
    required this.username,
    required this.password,
    required this.createdAt,
    required this.updatedAt,
  });

  final String id;
  final String name;
  final String site;
  final String username;
  final String password;
  final DateTime createdAt;
  final DateTime updatedAt;

  Map<String, Object?> toJson() => {
    'id': id,
    'name': name,
    'site': site,
    'username': username,
    'password': password,
    'createdAt': createdAt.toUtc().toIso8601String(),
    'updatedAt': updatedAt.toUtc().toIso8601String(),
  };

  factory VaultEntry.fromJson(Map<String, dynamic> json) {
    final id = json['id'] as String;
    final name = json['name'] as String;
    final password = json['password'] as String;
    if (id.isEmpty || name.trim().isEmpty || password.isEmpty) {
      throw const FormatException('Invalid password entry');
    }
    return VaultEntry(
      id: id,
      name: name,
      site: json['site'] as String,
      username: json['username'] as String,
      password: password,
      createdAt: DateTime.parse(json['createdAt'] as String),
      updatedAt: DateTime.parse(json['updatedAt'] as String),
    );
  }
}

class VaultData {
  const VaultData({
    required this.entries,
    required this.otpSecret,
    required this.period,
    required this.revision,
    required this.lastBackupRevision,
    required this.lastAcceptedStep,
  });

  final List<VaultEntry> entries;
  final String otpSecret;
  final int period;
  final int revision;
  final int lastBackupRevision;
  final int lastAcceptedStep;

  bool get backupOutdated => revision > lastBackupRevision;

  VaultData copyWith({
    List<VaultEntry>? entries,
    String? otpSecret,
    int? period,
    int? revision,
    int? lastBackupRevision,
    int? lastAcceptedStep,
  }) => VaultData(
    entries: entries ?? this.entries,
    otpSecret: otpSecret ?? this.otpSecret,
    period: period ?? this.period,
    revision: revision ?? this.revision,
    lastBackupRevision: lastBackupRevision ?? this.lastBackupRevision,
    lastAcceptedStep: lastAcceptedStep ?? this.lastAcceptedStep,
  );

  Map<String, Object?> toJson() => {
    'schema': 1,
    'entries': entries.map((e) => e.toJson()).toList(),
    'otpSecret': otpSecret,
    'period': period,
    'revision': revision,
    'lastBackupRevision': lastBackupRevision,
    'lastAcceptedStep': lastAcceptedStep,
  };

  factory VaultData.fromJson(Map<String, dynamic> json) {
    if (json['schema'] != 1)
      throw const FormatException('Unsupported vault schema');
    final period = json['period'] as int;
    if (period < 5 || period > 10)
      throw const FormatException('Invalid code period');
    final secret = json['otpSecret'] as String;
    if (base64Decode(secret).length != 32) {
      throw const FormatException('Invalid code secret');
    }
    return VaultData(
      entries: (json['entries'] as List<dynamic>)
          .map((value) => VaultEntry.fromJson(value as Map<String, dynamic>))
          .toList(),
      otpSecret: secret,
      period: period,
      revision: json['revision'] as int,
      lastBackupRevision: json['lastBackupRevision'] as int,
      lastAcceptedStep: json['lastAcceptedStep'] as int,
    );
  }
}
