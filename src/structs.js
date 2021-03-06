const {PublicKey} = require('eosjs-ecc')
const json = require('eosjs-json')
const Fcbuffer = require('fcbuffer')
const ByteBuffer = require('bytebuffer')
const assert = require('assert')
const binaryen = require('binaryen')

const {isName} = require('./format')
const {encodeName, decodeName} = require('./format')

/** Configures Fcbuffer for EOS specific structs and types. */
module.exports = (config = {}) => {

  const structLookup = name => structs[name]

  // Default to forceMessageDataHex until native ABIs are added, convert Message.data to hex
  // https://github.com/EOSIO/eos/issues/215
  const forceMessageDataHex = config.forceMessageDataHex != null ?
    config.forceMessageDataHex : true

  const override = Object.assign({},
    assetOverride,
    authorityOverride,
    abiOverride,
    wasmCodeOverride,
    messageDataOverride(structLookup, forceMessageDataHex),
    config.override
  )

  const eosTypes = {
    Name: ()=> [Name],
    PublicKey: () => [PublicKeyType],
    AssetSymbol: () => [AssetSymbol]
  }

  const customTypes = Object.assign({}, eosTypes, config.customTypes)
  config = Object.assign({override}, {customTypes}, config)

  const {structs, types, errors} = Fcbuffer(json.schema, config)
  if(errors.length !== 0) {
    throw new Error(JSON.stringify(errors, null, 4))
  }

  return {structs, types}
}

/**
  Name eos::types native.hpp
*/
const Name = (validation) => {
  return {
    fromByteBuffer (b) {
      const n = decodeName(b.readUint64(), false) // b is already in littleEndian
      // if(validation.debug) {
      //   console.error(`${n}`, '(Name.fromByteBuffer)')
      // }
      return n
    },
    appendByteBuffer (b, value) {
      // if(validation.debug) {
      //   console.error(`${value}`, (Name.appendByteBuffer))
      // }
      b.writeUint64(encodeName(value, false)) // b is already in littleEndian
    },
    fromObject (value) {
      return value
    },
    toObject (value) {
      if (validation.defaults && value == null) {
        return ''
      }
      return value
    }
  }
}

const PublicKeyType = (validation) => {
  return {
    fromByteBuffer (b) {
      const bcopy = b.copy(b.offset, b.offset + 33)
      b.skip(33)
      const pubbuf = Buffer.from(bcopy.toBinary(), 'binary')
      return PublicKey.fromBuffer(pubbuf).toString()
    },
    appendByteBuffer (b, value) {
      // if(validation.debug) {
      //   console.error(`${value}`, 'PublicKeyType.appendByteBuffer')
      // }
      const buf = PublicKey.fromStringOrThrow(value).toBuffer()
      b.append(buf.toString('binary'), 'binary')
    },
    fromObject (value) {
      return value
    },
    toObject (value) {
      if (validation.defaults && value == null) {
        return 'EOS6MRy..'
      }
      return value
    }
  }
}

const AssetSymbol = (validation) => {
  function valid(value) {
    if(typeof value !== 'string') {
      throw new TypeError(`Asset symbol should be a string`)
    }
    if(value.length > 7) {
      throw new TypeError(`Asset symbol is 7 characters or less`)
    }
  }
  const prefix = '\0\u0004'
  return {
    fromByteBuffer (b) {
      const bcopy = b.copy(b.offset, b.offset + 7)
      b.skip(7)

      const bin = bcopy.toBinary()
      if(bin.slice(0, 2) !== prefix) {
        throw new TypeError(`Asset symbol prefix does not jive`)
      }
      let symbol = ''
      for(code of bin.slice(2))  {
        if(code == '\0') {
          break
        }
        symbol += code
      }
      return symbol
    },
    appendByteBuffer (b, value) {
      valid(value)
      value += '\0'.repeat(6 - value.length)
      b.append(prefix + value)
    },
    fromObject (value) {
      valid(value)
      return value
    },
    toObject (value) {
      if (validation.defaults && value == null) {
        return 'SYMBOL'
      }
      valid(value)
      return value
    }
  }
}

const assetOverride = ({
  /** shorthand `1 EOS` for `{amount: 1, symbol: 'EOS'}` */
  'Asset.fromObject': (value) => {
    if(typeof value === 'string') {
      const val = value.trim().split(/ +/)
      assert.equal(val.length, 2, 'invalid asset')
      const [amount, symbol] = val
      assert(/^\d+\.?\d*$/.test(amount), 'amount should be digits')
      assert(typeof symbol, 'string', 'symbol should be a string')
      assert(isName(symbol.toLowerCase()), 'invalid symbol')
      return {amount, symbol}
    }
  }
})

const authorityOverride = ({
  /** shorthand `EOS6MRyAj..` */
  'Authority.fromObject': (value) => {
    if(PublicKey.fromString(value)) {
      return {
        threshold: 1,
        keys: [{key: value, weight: 1}],
        accounts: []
      }
    }
    if(isName(value)) {
      const [account, permission = 'active'] = value.split('@')
      return {
        threshold: 1,
        keys: [],
        accounts: [{
          permission: {
            account,
            permission
          },
          weight: 1
        }]
      }
    }
  }
})

const abiOverride = ({
  'Abi.fromObject': (value) => {
    if(typeof value === 'string') {
      return JSON.parse(value)
    }
    if(Buffer.isBuffer(value)) {
      return JSON.parse(value.toString())
    }
  }
})

const wasmCodeOverride = ({
  'setcode.code.fromObject': ({object, result}) => {
    try {
      const code = object.code.toString()
      if(/^\s*\(module/.test(code)) {
        console.log('Assembling WASM...')
        const wasm = Buffer.from(binaryen.parseText(code).emitBinary())
        result.code = wasm
      } else {
        result.code = object.code
      }
    } catch(error) {
      console.error(error, object.code)
    }
  }
})

/**
  Nested serialized structure.  Nested struct may be in HEX or object format.
*/
const messageDataOverride = (structLookup, forceMessageDataHex) => ({
  'Message.data.fromByteBuffer': ({fields, object, b, config}) => {
    const ser = (object.type || '') == '' ? fields.data : structLookup(object.type)
    if(ser) {
      b.readVarint32() // length prefix (usefull if object.type is unknown)
      object.data = ser.fromByteBuffer(b, config)
    } else {
      // console.log(`Unknown Message.type ${object.type}`)
      const lenPrefix = b.readVarint32()
      const bCopy = b.copy(b.offset, b.offset + lenPrefix)
      b.skip(lenPrefix)
      object.data = Buffer.from(bCopy.toBinary(), 'binary')
    }
  },

  'Message.data.appendByteBuffer': ({fields, object, b}) => {
    const ser = (object.type || '') == '' ? fields.data : structLookup(object.type)
    if(ser) {
      const b2 = new ByteBuffer(ByteBuffer.DEFAULT_CAPACITY, ByteBuffer.LITTLE_ENDIAN)
      ser.appendByteBuffer(b2, object.data)
      b.writeVarint32(b2.offset)
      b.append(b2.copy(0, b2.offset), 'binary')
    } else {
      // console.log(`Unknown Message.type ${object.type}`)
      const data = typeof object.data === 'string' ? new Buffer(object.data, 'hex') : object.data
      if(!Buffer.isBuffer(data)) {
        throw new TypeError('Expecting hex string or buffer in message.data')
      }
      b.writeVarint32(data.length)
      b.append(data.toString('binary'), 'binary')
    }
  },

  'Message.data.fromObject': ({fields, object, result}) => {
    const {data, type} = object
    const ser = (type || '') == '' ? fields.data : structLookup(type)
    if(ser) {
      if(typeof data === 'object') {
        result.data = ser.fromObject(data) // resolve shorthand
        return
      } else if(typeof data === 'string') {
        const buf = new Buffer(data, 'hex')
        result.data = Fcbuffer.fromBuffer(ser, buf)
      } else {
        throw new TypeError('Expecting hex string or object in message.data')
      }
    } else {
      // console.log(`Unknown Message.type ${object.type}`)
      result.data = data
    }
  },

  'Message.data.toObject': ({fields, object, result, config}) => {
    const {data, type} = object || {}
    const ser = (type || '') == '' ? fields.data : structLookup(type)
    if(!ser) {
      // Types without an ABI will accept hex
      // const b2 = new ByteBuffer(ByteBuffer.DEFAULT_CAPACITY, ByteBuffer.LITTLE_ENDIAN)
      // const buf = !Buffer.isBuffer(data) ? new Buffer(data, 'hex') : data
      // b2.writeVarint32(buf.length)
      // b2.append(buf)
      // result.data = b2.copy(0, b2.offset).toString('hex')
      result.data = Buffer.isBuffer(data) ? data.toString('hex') : data
      return
    }

    if(forceMessageDataHex) {
      const b2 = new ByteBuffer(ByteBuffer.DEFAULT_CAPACITY, ByteBuffer.LITTLE_ENDIAN)
      ser.appendByteBuffer(b2, data)
      
      result.data = b2.copy(0, b2.offset).toString('hex')

      // console.log('result.data', result.data)
      return
    }

    // Serializable JSON
    result.data = ser.toObject(data, config)
  }
})
