import 'dart:convert';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';

import 'crypto.dart';
import 'models.dart';

class BackupCrypto {
  static const format = 'TBD-BACKUP-v1';
  static const maxBytes = 10 * 1024 * 1024;
  static final _cipher = AesGcm.with256bits();
  static final _kdf = Argon2id(
    memory: 19456,
    iterations: 2,
    parallelism: 1,
    hashLength: 32,
  );

  static Future<SecretKey> _key(String password, List<int> salt) =>
      _kdf.deriveKeyFromPassword(password: password, nonce: salt);

  static Future<Uint8List> create(VaultData data, String password) async {
    if (password.runes.length < 12) {
      throw ArgumentError('Backup password must be at least 12 characters');
    }
    final salt = randomBytes(16);
    final nonce = randomBytes(12);
    final box = await _cipher.encrypt(
      utf8.encode(jsonEncode(data.toJson())),
      secretKey: await _key(password, salt),
      nonce: nonce,
      aad: utf8.encode(format),
    );
    return Uint8List.fromList(
      utf8.encode(
        jsonEncode({
          'format': format,
          'kdf': 'argon2id-19456-2-1',
          'salt': base64Encode(salt),
          'nonce': base64Encode(nonce),
          'ciphertext': base64Encode(box.cipherText),
          'mac': base64Encode(box.mac.bytes),
        }),
      ),
    );
  }

  static Future<VaultData> restore(List<int> bytes, String password) async {
    if (bytes.length > maxBytes)
      throw const FormatException('Backup too large');
    final outer = jsonDecode(utf8.decode(bytes)) as Map<String, dynamic>;
    if (outer['format'] != format || outer['kdf'] != 'argon2id-19456-2-1') {
      throw const FormatException('Unsupported backup');
    }
    final salt = base64Decode(outer['salt'] as String);
    final nonce = base64Decode(outer['nonce'] as String);
    final mac = base64Decode(outer['mac'] as String);
    if (salt.length != 16 || nonce.length != 12 || mac.length != 16) {
      throw const FormatException('Invalid backup');
    }
    final clear = await _cipher.decrypt(
      SecretBox(
        base64Decode(outer['ciphertext'] as String),
        nonce: nonce,
        mac: Mac(mac),
      ),
      secretKey: await _key(password, salt),
      aad: utf8.encode(format),
    );
    return VaultData.fromJson(
      jsonDecode(utf8.decode(clear)) as Map<String, dynamic>,
    );
  }
}
