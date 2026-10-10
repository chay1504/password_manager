import 'dart:convert';
import 'dart:io';

import 'package:tbd_core/tbd_core.dart';
import 'package:test/test.dart';

void main() {
  final secret = List<int>.generate(32, (i) => i);
  final sample = VaultData(
    entries: [
      VaultEntry(
        id: 'one',
        name: 'Example',
        site: 'example.com',
        username: 'friend',
        password: 'long unique password',
        createdAt: DateTime.utc(2026, 1, 1),
        updatedAt: DateTime.utc(2026, 1, 1),
      ),
    ],
    otpSecret: base64Encode(secret),
    period: 10,
    revision: 1,
    lastBackupRevision: 0,
    lastAcceptedStep: -1,
  );

  test('SHA-256 TOTP matches RFC 6238 vector', () {
    expect(
      Otp.code(
        utf8.encode('12345678901234567890123456789012'),
        DateTime.fromMillisecondsSinceEpoch(59000, isUtc: true),
        30,
      ),
      '46119246',
    );
  });

  test('vault encryption round trip and wrong key rejection', () async {
    final key = randomBytes(32);
    final encrypted = await VaultCrypto.encrypt(
      utf8.encode(jsonEncode(sample.toJson())),
      key,
    );
    expect(encrypted, isNot(contains('long unique password')));
    final clear = await VaultCrypto.decrypt(encrypted, key);
    expect(
      jsonDecode(utf8.decode(clear))['entries'][0]['password'],
      'long unique password',
    );
    await expectLater(
      VaultCrypto.decrypt(encrypted, randomBytes(32)),
      throwsA(isA<Exception>()),
    );
  });

  test('backup restores entries and rejects wrong password or edits', () async {
    final bytes = await BackupCrypto.create(sample, 'a long backup password');
    expect(utf8.decode(bytes), isNot(contains('long unique password')));
    final restored = await BackupCrypto.restore(
      bytes,
      'a long backup password',
    );
    expect(restored.entries.single.password, sample.entries.single.password);
    await expectLater(
      BackupCrypto.restore(bytes, 'incorrect password'),
      throwsA(isA<Exception>()),
    );
    final document = jsonDecode(utf8.decode(bytes)) as Map<String, dynamic>;
    final encrypted = base64Decode(document['ciphertext'] as String);
    encrypted[0] ^= 1;
    document['ciphertext'] = base64Encode(encrypted);
    await expectLater(
      BackupCrypto.restore(
        utf8.encode(jsonEncode(document)),
        'a long backup password',
      ),
      throwsA(isA<Exception>()),
    );
  });

  test('vault file survives an updated write', () async {
    final folder = await Directory.systemTemp.createTemp('tbd-vault-test-');
    try {
      final file = VaultFile(File('${folder.path}/vault.tbd'));
      final key = randomBytes(32);
      await file.write(sample, key);
      await file.write(sample.copyWith(revision: 2), key);
      expect((await file.read(key)).revision, 2);
    } finally {
      await folder.delete(recursive: true);
    }
  });

  group('code timing', () {
    test('step and secondsLeft agree at interval boundaries', () {
      for (final period in [5, 7, 10]) {
        final start = DateTime.fromMillisecondsSinceEpoch(
          period * 1000 * 12345,
          isUtc: true,
        );
        expect(Otp.step(start, period), 12345);
        expect(Otp.secondsLeft(start, period), period);
        final last = start.add(Duration(milliseconds: period * 1000 - 1));
        expect(Otp.step(last, period), 12345);
        expect(Otp.secondsLeft(last, period), 1);
        final next = start.add(Duration(seconds: period));
        expect(Otp.step(next, period), 12346);
      }
    });

    test('codes are eight digits and change between intervals', () {
      final key = List<int>.generate(32, (i) => i);
      final at = DateTime.utc(2026, 1, 1, 0, 0, 1);
      for (final period in [5, 7, 10]) {
        final a = Otp.code(key, at, period);
        final b = Otp.code(key, at.add(Duration(seconds: period)), period);
        expect(a, matches(RegExp(r'^\d{8}$')));
        expect(a, isNot(b));
        expect(Otp.code(key, at, period), a);
      }
    });

    test('matches rejects malformed input and a different secret', () {
      final key = List<int>.generate(32, (i) => i);
      final at = DateTime.utc(2026, 1, 1, 0, 0, 1);
      final good = Otp.code(key, at, 10);
      final b64 = base64Encode(key);
      expect(Otp.matches(good, b64, at, 10), isTrue);
      expect(Otp.matches('$good ', b64, at, 10), isFalse);
      expect(Otp.matches(good.substring(1), b64, at, 10), isFalse);
      expect(Otp.matches('', b64, at, 10), isFalse);
      expect(
        Otp.matches(good, base64Encode(List<int>.filled(32, 9)), at, 10),
        isFalse,
      );
    });
  });

  group('backup files', () {
    const password = 'a long backup password';

    Future<Map<String, dynamic>> fresh() async => jsonDecode(
      utf8.decode(await BackupCrypto.create(sample, password)),
    ) as Map<String, dynamic>;

    List<int> encode(Map<String, dynamic> document) =>
        utf8.encode(jsonEncode(document));

    test('every altered field is rejected', () async {
      for (final field in ['salt', 'nonce', 'ciphertext', 'mac']) {
        final document = await fresh();
        final raw = base64Decode(document[field] as String);
        raw[raw.length - 1] ^= 1;
        document[field] = base64Encode(raw);
        await expectLater(
          BackupCrypto.restore(encode(document), password),
          throwsA(isA<Exception>()),
          reason: field,
        );
      }
      for (final field in ['format', 'kdf']) {
        final document = await fresh();
        document[field] = '${document[field]}x';
        await expectLater(
          BackupCrypto.restore(encode(document), password),
          throwsA(isA<FormatException>()),
          reason: field,
        );
      }
    });

    test('missing fields, truncation and garbage are rejected', () async {
      final bytes = await BackupCrypto.create(sample, password);
      final document = await fresh()..remove('mac');
      final inputs = <List<int>>[
        encode(document),
        bytes.sublist(0, bytes.length ~/ 2),
        utf8.encode('not json at all'),
        utf8.encode('[]'),
        <int>[],
        List<int>.generate(300, (i) => i),
      ];
      for (final input in inputs) {
        await expectLater(
          BackupCrypto.restore(input, password),
          throwsA(isA<Object>()),
        );
      }
    });

    test('oversize files are refused before decoding', () async {
      await expectLater(
        BackupCrypto.restore(
          List<int>.filled(BackupCrypto.maxBytes + 1, 0x20),
          password,
        ),
        throwsA(isA<FormatException>()),
      );
    });

    test('short backup passwords are refused at creation', () async {
      await expectLater(
        BackupCrypto.create(sample, 'too short'),
        throwsA(isA<ArgumentError>()),
      );
    });

    test('two backups of the same vault differ (fresh salt and nonce)', () async {
      final a = await BackupCrypto.create(sample, password);
      final b = await BackupCrypto.create(sample, password);
      expect(a, isNot(b));
    });

    test('checked-in v1 fixture still opens with its password', () async {
      final bytes = await File('test/fixtures/backup-v1.fixture').readAsBytes();
      final restored = await BackupCrypto.restore(
        bytes,
        'fixture backup password',
      );
      expect(restored.period, 7);
      expect(restored.revision, 3);
      expect(restored.entries.single.name, 'Fixture Account');
      expect(restored.entries.single.password, 'fixture-password-\u00e9\u4e2d');
      expect(
        base64Decode(restored.otpSecret),
        List<int>.generate(32, (i) => 255 - i),
      );
      await expectLater(
        BackupCrypto.restore(bytes, 'wrong fixture password'),
        throwsA(isA<Exception>()),
      );
    });
  });
}
