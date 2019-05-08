/* global THREE, ActiveXObject, TextureLoader */
'use strict';

// Inspiration: https://github.com/lkolbly/threejs-x3dloader/blob/master/X3DLoader.js

THREE.X3DLoader = class X3DLoader {
  constructor(scene, loadManager) {
    this.manager = (typeof loadManager !== 'undefined') ? loadManager : THREE.DefaultLoadingManager;
    this.scene = scene;
    this.parsedObjects = [];
    this.directionalLights = [];
  };

  load(url, onLoad, onProgress, onError) {
    console.log('X3D: Loading ' + url);
    var scope = this;
    var loader = new THREE.FileLoader(scope.manager);
    loader.load(url, (text) => {
      if (typeof onLoad !== 'undefined')
        onLoad(scope.parse(text));
    });
  }

  parse(text) {
    this.directionalLights = [];
    var object;

    console.log('X3D: Parsing');

    var xml = null;
    if (window.DOMParser) {
      var parser = new DOMParser();
      xml = parser.parseFromString(text, 'text/xml');
    } else { // Internet Explorer
      xml = new ActiveXObject('Microsoft.XMLDOM');
      xml.async = false;
      xml.loadXML(text);
    }

    // Parse scene.
    var scene = xml.getElementsByTagName('Scene')[0];
    if (typeof scene !== 'undefined') {
      object = new THREE.Object3D();
      object.userData.x3dType = 'Group';
      object.name = 'n0';
      this.parsedObjects.push(object); // push before parsing to let _getDefNode work correctly
      this.parseNode(object, scene);
      return this.parsedObjects;
    }

    // Parse objects.
    var rootObjects = [];
    xml.childNodes.forEach((n) => { rootObjects.push(n); });
    while (rootObjects.length > 0) {
      var node = rootObjects.pop();
      object = new THREE.Object3D();
      this.parsedObjects.push(object); // push before parsing
      this.parseNode(object, node);
    }
    return this.parsedObjects;
  }

  parseNode(parentObject, node) {
    var object = this._getDefNode(node);
    if (typeof object !== 'undefined') {
      var useObject = object.clone();
      this._setCustomId(node, useObject, object);
      parentObject.add(useObject);
      return;
    }

    var hasChildren = false;
    var helperNodes = [];
    if (node.tagName === 'Transform') {
      object = this.parseTransform(node);
      hasChildren = true;
    } else if (node.tagName === 'Shape')
      object = this.parseShape(node);
    else if (node.tagName === 'DirectionalLight')
      object = this.parseDirectionalLight(node);
    else if (node.tagName === 'PointLight')
      object = this.parsePointLight(node);
    else if (node.tagName === 'SpotLight')
      object = this.parseSpotLight(node, helperNodes);
    else if (node.tagName === 'Group') {
      object = new THREE.Object3D();
      object.userData.x3dType = 'Group';
      hasChildren = true;
    } else if (node.tagName === 'Switch') {
      object = new THREE.Object3D();
      object.visible = getNodeAttribute(node, 'whichChoice', '-1') !== '-1';
      object.userData.x3dType = 'Switch';
      hasChildren = true;
    } else if (node.tagName === 'Fog')
      this.parseFog(node);
    else if (node.tagName === 'Viewpoint')
      object = this.parseViewpoint(node);
    else if (node.tagName === 'Background')
      object = this.parseBackground(node);
    else if (node.tagName === 'WorldInfo') {
      this.parseWorldInfo(node);
      return;
    } else {
      this.parseChildren(node, parentObject);
      return;
    }

    if (typeof object !== 'undefined') {
      var isInvisible = getNodeAttribute(node, 'render', 'true').toLowerCase() === 'false';
      if (isInvisible && object.visible)
        object.visible = false;
      this._setCustomId(node, object);
      parentObject.add(object);
    }

    if (helperNodes.length > 0) {
      helperNodes.forEach((o) => {
        parentObject.add(o);
      });
    }

    if (hasChildren)
      this.parseChildren(node, object);
  }

  parseChildren(node, currentObject) {
    for (let i = 0; i < node.childNodes.length; i++) {
      var child = node.childNodes[i];
      if (typeof child.tagName !== 'undefined')
        this.parseNode(currentObject, child);
    }
  }

  parseTransform(transform) {
    var object = new THREE.Object3D();
    object.userData.x3dType = 'Transform';
    object.userData.solid = getNodeAttribute(transform, 'solid', 'false').toLowerCase() === 'true';
    object.userData.window = getNodeAttribute(transform, 'window', '');
    var controller = getNodeAttribute(transform, 'controller', undefined);
    if (typeof controller !== 'undefined')
      object.userData.controller = controller;
    object.userData.name = getNodeAttribute(transform, 'name', '');

    var position = convertStringToVec3(getNodeAttribute(transform, 'translation', '0 0 0'));
    object.position.copy(position);
    var scale = convertStringToVec3(getNodeAttribute(transform, 'scale', '1 1 1'));
    object.scale.copy(scale);
    var quaternion = convertStringToQuaternion(getNodeAttribute(transform, 'rotation', '0 1 0 0'));
    object.quaternion.copy(quaternion);

    return object;
  }

  parseShape(shape) {
    var geometry;
    var material;

    for (let i = 0; i < shape.childNodes.length; i++) {
      var child = shape.childNodes[i];
      if (typeof child.tagName === 'undefined')
        continue;

      // Check if USE node and return the DEF node.
      var defObject = this._getDefNode(child);
      if (typeof defObject !== 'undefined') {
        if (defObject.isGeometry || defObject.isBufferGeometry)
          geometry = defObject;
        else if (defObject.isMaterial)
          material = defObject;
        // else error
        continue;
      }

      if (typeof material === 'undefined') {
        if (child.tagName === 'Appearance') {
          // If a sibling PBRAppearance is detected, prefer it.
          var pbrAppearanceChild = false;
          for (let j = 0; j < shape.childNodes.length; j++) {
            var child0 = shape.childNodes[j];
            if (child0.tagName === 'PBRAppearance') {
              pbrAppearanceChild = true;
              break;
            }
          }
          if (pbrAppearanceChild)
            continue;
          else
            material = this.parseAppearance(child);
        } else if (child.tagName === 'PBRAppearance')
          material = this.parsePBRAppearance(child);

        if (typeof material !== 'undefined') {
          this._setCustomId(child, material);
          continue;
        }
      }

      if (typeof geometry === 'undefined') {
        if (child.tagName === 'Box')
          geometry = this.parseBox(child);
        else if (child.tagName === 'Cone')
          geometry = this.parseCone(child);
        else if (child.tagName === 'Cylinder')
          geometry = this.parseCylinder(child);
        else if (child.tagName === 'IndexedFaceSet')
          geometry = this.parseIndexedFaceSet(child);
        else if (child.tagName === 'Sphere')
          geometry = this.parseSphere(child);
        else if (child.tagName === 'Plane')
          geometry = this.parsePlane(child);
        else if (child.tagName === 'ElevationGrid')
          geometry = this.parseElevationGrid(child);
        else if (child.tagName === 'IndexedLineSet')
          geometry = this.parseIndexedLineSet(child);
        else if (child.tagName === 'PointSet')
          geometry = this.parsePointSet(child);

        if (typeof geometry !== 'undefined') {
          this._setCustomId(child, geometry);
          continue;
        }
      }

      console.log('X3dLoader: Unknown node: ' + child.tagName);
    }

    // Apply default geometry and/or material.
    if (typeof geometry === 'undefined')
      geometry = createDefaultGeometry();
    if (typeof material === 'undefined')
      material = createDefaultMaterial(geometry);

    var mesh;
    if (geometry.userData.x3dType === 'IndexedLineSet')
      mesh = new THREE.LineSegments(geometry, material);
    else if (geometry.userData.x3dType === 'PointSet')
      mesh = new THREE.Points(geometry, material);
    else
      mesh = new THREE.Mesh(geometry, material);
    mesh.userData.x3dType = 'Shape';

    if (!material.transparent && !material.userData.hasTransparentTexture)
      // Webots transparent object don't cast shadows.
      mesh.castShadow = getNodeAttribute(shape, 'castShadows', 'false').toLowerCase() === 'true';
    mesh.receiveShadow = true;
    mesh.userData.isPickable = getNodeAttribute(shape, 'isPickable', 'true').toLowerCase() === 'true';
    return mesh;
  }

  parseAppearance(appearance) {
    var mat = new THREE.MeshBasicMaterial({color: 0xffffff});
    mat.userData.x3dType = 'Appearance';

    // Get the Material tag.
    var material = appearance.getElementsByTagName('Material')[0];

    var materialSpecifications = {};
    if (typeof material !== 'undefined') {
      var defMaterial = this._getDefNode(material);
      if (typeof defMaterial !== 'undefined') {
        materialSpecifications = {
          'color': defMaterial.color,
          'specular': defMaterial.specular,
          'emissive': defMaterial.emissive,
          'shininess': defMaterial.shininess
        };
      } else {
        // Pull out the standard colors.
        materialSpecifications = {
          'color': convertStringTorgb(getNodeAttribute(material, 'diffuseColor', '0.8 0.8 0.8')),
          'specular': convertStringTorgb(getNodeAttribute(material, 'specularColor', '0 0 0')),
          'emissive': convertStringTorgb(getNodeAttribute(material, 'emissiveColor', '0 0 0')),
          'shininess': parseFloat(getNodeAttribute(material, 'shininess', '0.2')),
          'transparent': getNodeAttribute(appearance, 'sortType', 'auto') === 'transparent'
        };
      }
    }

    // Check to see if there is a texture.
    var imageTexture = appearance.getElementsByTagName('ImageTexture');
    var colorMap;
    if (imageTexture.length > 0) {
      colorMap = this.parseImageTexture(imageTexture[0], appearance.getElementsByTagName('TextureTransform'));
      if (typeof colorMap !== 'undefined') {
        materialSpecifications.map = colorMap;
        if (colorMap.userData.isTransparent) {
          materialSpecifications.transparent = true;
          materialSpecifications.alphaTest = 0.5; // FIXME needed for example for the target.png in robot_programming.wbt
        }
      }
    }

    mat = new THREE.MeshPhongMaterial(materialSpecifications);
    mat.userData.x3dType = 'Appearance';
    mat.userData.hasTransparentTexture = colorMap && colorMap.userData.isTransparent;
    if (typeof material !== 'undefined')
      this._setCustomId(material, mat);

    return mat;
  }

  parsePBRAppearance(pbrAppearance) {
    var isTransparent = false;

    var baseColor = convertStringTorgb(getNodeAttribute(pbrAppearance, 'baseColor', '1 1 1'));
    var roughness = parseFloat(getNodeAttribute(pbrAppearance, 'roughness', '0'));
    var metalness = parseFloat(getNodeAttribute(pbrAppearance, 'metalness', '1'));
    var emissiveColor = convertStringTorgb(getNodeAttribute(pbrAppearance, 'emissiveColor', '0 0 0'));
    var transparency = parseFloat(getNodeAttribute(pbrAppearance, 'transparency', '0'));
    var materialSpecifications = {
      color: baseColor,
      roughness: roughness,
      metalness: metalness,
      emissive: emissiveColor
    };

    if (transparency) {
      materialSpecifications.opacity = 1.0 - transparency;
      isTransparent = true;
    }

    var textureTransform = pbrAppearance.getElementsByTagName('TextureTransform');
    var imageTextures = pbrAppearance.getElementsByTagName('ImageTexture');
    for (let t = 0; t < imageTextures.length; t++) {
      var imageTexture = imageTextures[t];
      var type = getNodeAttribute(imageTexture, 'type', undefined);
      if (type === 'baseColor') {
        materialSpecifications.map = this.parseImageTexture(imageTexture, textureTransform);
        if (typeof materialSpecifications.map !== 'undefined' && materialSpecifications.map.userData.isTransparent) {
          isTransparent = true;
          materialSpecifications.alphaTest = 0.5; // FIXME needed for example for the target.png in robot_programming.wbt
        }
      } else if (type === 'roughness') {
        materialSpecifications.roughnessMap = this.parseImageTexture(imageTexture, textureTransform);
        materialSpecifications.roughness = 1.0;
      } else if (type === 'metalness')
        materialSpecifications.metalnessMap = this.parseImageTexture(imageTexture, textureTransform);
      else if (type === 'normal')
        materialSpecifications.normalMap = this.parseImageTexture(imageTexture, textureTransform);
      else if (type === 'emissiveColor') {
        materialSpecifications.emissiveMap = this.parseImageTexture(imageTexture, textureTransform);
        materialSpecifications.emissive = new THREE.Color(0xffffff);
      }
      /* Ambient occlusion not fully working
      else if (type === 'occlusion')
        materialSpecifications.aoMap = this.parseImageTexture(imageTexture, textureTransform);
      */
    }

    var mat = new THREE.MeshStandardMaterial(materialSpecifications);
    mat.userData.x3dType = 'PBRAppearance';
    if (isTransparent)
      mat.transparent = true;
    mat.userData.hasTransparentTexture = materialSpecifications.map && materialSpecifications.map.userData.isTransparent;

    return mat;
  }

  parseImageTexture(imageTexture, textureTransform, mat) {
    // Issues with DEF and USE image texture with different image transform.
    var texture = this._getDefNode(imageTexture);
    if (typeof texture !== 'undefined')
      return texture;

    texture = new THREE.Texture();

    var filename = getNodeAttribute(imageTexture, 'url', '');
    filename = filename.split(/['"\s]/).filter((n) => { return n; });
    if (filename[0] == null)
      return undefined;

    // Look for already loaded texture or load the texture in an asynchronous way.
    var image = TextureLoader.loadOrRetrieve(filename[0], texture);
    if (typeof image !== 'undefined') { // else it could be updated later
      texture.image = image;
      texture.needsUpdate = true;
    }
    texture.userData = {
      'isTransparent': getNodeAttribute(imageTexture, 'isTransparent', 'false').toLowerCase() === 'true',
      'url': filename[0]
    };

    var wrapS = getNodeAttribute(imageTexture, 'repeatS', 'true').toLowerCase();
    var wrapT = getNodeAttribute(imageTexture, 'repeatT', 'true').toLowerCase();
    texture.wrapS = wrapS === 'true' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
    texture.wrapT = wrapT === 'true' ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;

    if (textureTransform && textureTransform[0]) {
      var defTexture = this._getDefNode(textureTransform[0]);
      if (typeof defTexture !== 'undefined')
        texture.userData.transform = defTexture.userData.transform;
      else {
        texture.userData.transform = {
          'center': convertStringToVec2(getNodeAttribute(textureTransform[0], 'center', '0 0')),
          'rotation': parseFloat(getNodeAttribute(textureTransform[0], 'rotation', '0')),
          'scale': convertStringToVec2(getNodeAttribute(textureTransform[0], 'scale', '1 1')),
          'translation': convertStringToVec2(getNodeAttribute(textureTransform[0], 'translation', '0 0'))
        };
      }

      texture.matrixAutoUpdate = false;
      texture.onUpdate = () => {
        // X3D UV transform matrix differs from THREE.js default one
        // http://www.web3d.org/documents/specifications/19775-1/V3.2/Part01/components/texturing.html#TextureTransform
        var transform = texture.userData.transform;
        var c = Math.cos(-transform.rotation);
        var s = Math.sin(-transform.rotation);
        var sx = transform.scale.x;
        var sy = transform.scale.y;
        var cx = transform.center.x;
        var cy = transform.center.y;
        var tx = transform.translation.x;
        var ty = transform.translation.y;
        texture.matrix.set(
          sx * c, sx * s, sx * (tx * c + ty * s + cx * c + cy * s) - cx,
          -sy * s, sy * c, sy * (-tx * s + ty * c - cx * s + cy * c) - cy,
          0, 0, 1
        );
      };
      texture.needsUpdate = true;

      this._setCustomId(textureTransform[0], texture);
    }

    this._setCustomId(imageTexture, texture);
    return texture;
  }

  parseIndexedFaceSet(ifs) {
    var coordinate = ifs.getElementsByTagName('Coordinate')[0];
    var textureCoordinate = ifs.getElementsByTagName('TextureCoordinate')[0];
    var normal = ifs.getElementsByTagName('Normal')[0];

    if (typeof coordinate !== 'undefined' && 'USE' in coordinate.attributes) {
      console.error("X3DLoader:parseIndexedFaceSet: USE 'Coordinate' node not supported.");
      coordinate = undefined;
    }
    if (typeof textureCoordinate !== 'undefined' && 'USE' in textureCoordinate.attributes) {
      console.error("X3DLoader:parseIndexedFaceSet: USE 'TextureCoordinate' node not supported.");
      textureCoordinate = undefined;
    }
    if (typeof normal !== 'undefined' && 'USE' in normal.attributes) {
      console.error("X3DLoader:parseIndexedFaceSet: USE 'Normal' node not supported.");
      normal = undefined;
    }

    var geometry = new THREE.Geometry();
    var x3dType = getNodeAttribute(ifs, 'x3dType', undefined);
    geometry.userData = { 'x3dType': (typeof x3dType === 'undefined' ? 'IndexedFaceSet' : x3dType) };
    if (typeof coordinate === 'undefined')
      return geometry;

    var indicesStr = getNodeAttribute(ifs, 'coordIndex', '').split(/\s/);
    var verticesStr = getNodeAttribute(coordinate, 'point', '').split(/\s/);
    var hasTexCoord = 'texCoordIndex' in ifs.attributes;
    var texcoordIndexStr = hasTexCoord ? getNodeAttribute(ifs, 'texCoordIndex', '') : '';
    var texcoordsStr = hasTexCoord ? getNodeAttribute(textureCoordinate, 'point', '') : '';

    for (let i = 0; i < verticesStr.length; i += 3) {
      var v = new THREE.Vector3();
      v.x = parseFloat(verticesStr[i + 0]);
      v.y = parseFloat(verticesStr[i + 1]);
      v.z = parseFloat(verticesStr[i + 2]);
      geometry.vertices.push(v);
    }

    var normalArray, normalIndicesStr;
    if (typeof normal !== 'undefined') {
      var normalStr = getNodeAttribute(normal, 'vector', '').split(/[\s,]+/);
      normalIndicesStr = getNodeAttribute(ifs, 'normalIndex', '').split(/\s/);
      normalArray = [];
      for (let i = 0; i < normalStr.length; i += 3) {
        normalArray.push(new THREE.Vector3(
          parseFloat(normalStr[i + 0]),
          parseFloat(normalStr[i + 1]),
          parseFloat(normalStr[i + 2])));
      }
    }

    if (hasTexCoord) {
      var texcoords = texcoordsStr.split(/\s/);
      var uvs = [];
      for (let i = 0; i < texcoords.length; i += 2) {
        v = new THREE.Vector2();
        v.x = parseFloat(texcoords[i + 0]);
        v.y = parseFloat(texcoords[i + 1]);
        uvs.push(v);
      }
    }

    // Now pull out the face indices.
    if (hasTexCoord)
      var texIndices = texcoordIndexStr.split(/\s/);
    for (let i = 0; i < indicesStr.length; i++) {
      var faceIndices = [];
      var uvIndices = [];
      var normalIndices = [];
      while (parseFloat(indicesStr[i]) >= 0) {
        faceIndices.push(parseFloat(indicesStr[i]));
        if (hasTexCoord)
          uvIndices.push(parseFloat(texIndices[i]));
        if (typeof normalIndicesStr !== 'undefined')
          normalIndices.push(parseFloat(normalIndicesStr[i]));
        i++;
      }

      var faceNormal;
      while (faceIndices.length > 3) {
        // Take the last three, make a triangle, and remove the
        // middle one (works for convex & continuously wrapped).
        if (hasTexCoord) {
          // Add to the UV layer.
          geometry.faceVertexUvs[0].push([
            uvs[parseFloat(uvIndices[uvIndices.length - 3])].clone(),
            uvs[parseFloat(uvIndices[uvIndices.length - 2])].clone(),
            uvs[parseFloat(uvIndices[uvIndices.length - 1])].clone()
          ]);
          // Remove the second-to-last vertex.
          var tmp = uvIndices[uvIndices.length - 1];
          uvIndices.pop();
          uvIndices[uvIndices.length - 1] = tmp;
        }

        faceNormal = undefined;
        if (typeof normal !== 'undefined') {
          faceNormal = [
            normalArray[normalIndices[faceIndices.length - 3]],
            normalArray[normalIndices[faceIndices.length - 2]],
            normalArray[normalIndices[faceIndices.length - 1]]];
        }

        // Make a face.
        geometry.faces.push(new THREE.Face3(
          faceIndices[faceIndices.length - 3],
          faceIndices[faceIndices.length - 2],
          faceIndices[faceIndices.length - 1],
          faceNormal
        ));
        // Remove the second-to-last vertex.
        tmp = faceIndices[faceIndices.length - 1];
        faceIndices.pop();
        faceIndices[faceIndices.length - 1] = tmp;
      }

      // Make a face with the final three.
      if (faceIndices.length === 3) {
        if (hasTexCoord) {
          geometry.faceVertexUvs[0].push([
            uvs[parseFloat(uvIndices[uvIndices.length - 3])].clone(),
            uvs[parseFloat(uvIndices[uvIndices.length - 2])].clone(),
            uvs[parseFloat(uvIndices[uvIndices.length - 1])].clone()
          ]);
        }

        if (typeof normal !== 'undefined') {
          faceNormal = [
            normalArray[normalIndices[faceIndices.length - 3]],
            normalArray[normalIndices[faceIndices.length - 2]],
            normalArray[normalIndices[faceIndices.length - 1]]];
        }

        geometry.faces.push(new THREE.Face3(
          faceIndices[0], faceIndices[1], faceIndices[2], faceNormal
        ));
      }
    }

    geometry.computeBoundingSphere();
    if (typeof normal === 'undefined')
      geometry.computeVertexNormals();

    this._setCustomId(coordinate, geometry);
    if (hasTexCoord)
      this._setCustomId(textureCoordinate, geometry);

    return geometry;
  }

  parseIndexedLineSet(ils) {
    var coordinate = ils.getElementsByTagName('Coordinate')[0];
    if (typeof coordinate !== 'undefined' && 'USE' in coordinate.attributes) {
      console.error("X3DLoader:parseIndexedLineSet: USE 'Coordinate' node not supported.");
      coordinate = undefined;
    }

    var geometry = new THREE.BufferGeometry();
    geometry.userData = { 'x3dType': 'IndexedLineSet' };
    if (typeof coordinate === 'undefined')
      return geometry;

    var indicesStr = getNodeAttribute(ils, 'coordIndex', '').trim().split(/\s/);
    var verticesStr = getNodeAttribute(coordinate, 'point', '').trim().split(/\s/);

    var positions = new Float32Array(verticesStr.length * 3);
    for (let i = 0; i < verticesStr.length; i += 3) {
      positions[i] = parseFloat(verticesStr[i + 0]);
      positions[i + 1] = parseFloat(verticesStr[i + 1]);
      positions[i + 2] = parseFloat(verticesStr[i + 2]);
    }

    var indices = [];
    for (let i = 0; i < indicesStr.length; i++) {
      while (parseFloat(indicesStr[i]) >= 0) {
        indices.push(parseFloat(indicesStr[i]));
        i++;
      }
    }

    geometry.setIndex(new THREE.BufferAttribute(new Uint16Array(indices), 1));
    geometry.addAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.computeBoundingSphere();

    this._setCustomId(coordinate, geometry);

    return geometry;
  }

  parseElevationGrid(eg) {
    var heightStr = getNodeAttribute(eg, 'height', undefined);
    var xDimension = parseInt(getNodeAttribute(eg, 'xDimension', '0'));
    var xSpacing = parseFloat(getNodeAttribute(eg, 'xSpacing', '1'));
    var zDimension = parseInt(getNodeAttribute(eg, 'zDimension', '0'));
    var zSpacing = parseFloat(getNodeAttribute(eg, 'zSpacing', '1'));

    var width = (xDimension - 1) * xSpacing;
    var depth = (zDimension - 1) * zSpacing;

    var geometry = new THREE.PlaneBufferGeometry(width, depth, xDimension - 1, zDimension - 1);
    geometry.userData = { 'x3dType': 'ElevationGrid' };
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(width / 2, 0, depth / 2); // center located in the corner
    if (typeof heightStr === 'undefined')
      return geometry;

    // Set height and adjust uv mappings.
    var heightArray = heightStr.trim().split(/\s/);
    var vertices = geometry.getAttribute('position').array;
    var uv = geometry.getAttribute('uv').array;
    var maxIndex = heightArray.length;
    var i = 0;
    var v = 1;
    for (let dx = 0; dx < xDimension; dx++) {
      for (let dz = 0; dz < zDimension; dz++) {
        var index = xDimension * dx + dz;
        if (index < maxIndex)
          vertices[i + 1] = parseFloat(heightArray[index]);
        uv[v] = -uv[v];
        i += 3;
        v += 2;
      }
    }

    return geometry;
  }

  parseBox(box) {
    var size = convertStringToVec3(getNodeAttribute(box, 'size', '2 2 2'));
    var boxGeometry = new THREE.BoxBufferGeometry(size.x, size.y, size.z);
    boxGeometry.userData = { 'x3dType': 'Box' };
    return boxGeometry;
  }

  parseCone(cone) {
    var radius = getNodeAttribute(cone, 'bottomRadius', '0');
    var height = getNodeAttribute(cone, 'height', '0');
    var subdivision = getNodeAttribute(cone, 'subdivision', '32');
    var openEnded = getNodeAttribute(cone, 'bottom', 'true').toLowerCase() !== 'true';
    // var openSided = getNodeAttribute(cone, 'side', 'true').toLowerCase() === 'true' ? false : true;
    // set thetaStart = Math.PI / 2 to match X3D texture mapping
    var coneGeometry = new THREE.ConeBufferGeometry(radius, height, subdivision, 1, openEnded, Math.PI / 2);
    coneGeometry.userData = { 'x3dType': 'Cone' };
    coneGeometry.rotateY(Math.PI / 2);
    return coneGeometry;
  }

  parseCylinder(cylinder) {
    var radius = getNodeAttribute(cylinder, 'radius', '0');
    var height = getNodeAttribute(cylinder, 'height', '0');
    var subdivision = getNodeAttribute(cylinder, 'subdivision', '32');
    var openEnded = getNodeAttribute(cylinder, 'bottom', 'true').toLowerCase() !== 'true';
    // var openSided = getNodeAttribute(cylinder, 'side', 'true').toLowerCase() === 'true' ? false : true;
    // var openTop = getNodeAttribute(cylinder, 'top', 'true').toLowerCase() === 'true' ? false : true;
    // set thetaStart = Math.PI / 2 to match X3D texture mapping
    var cylinderGeometry = new THREE.CylinderBufferGeometry(radius, radius, height, subdivision, 1, openEnded, Math.PI / 2);
    cylinderGeometry.userData = { 'x3dType': 'Cylinder' };
    cylinderGeometry.rotateY(Math.PI / 2);
    return cylinderGeometry;
  }

  parseSphere(sphere) {
    var radius = getNodeAttribute(sphere, 'radius', '1');
    var subdivision = getNodeAttribute(sphere, 'subdivision', '8,8').split(',');
    var sphereGeometry = new THREE.SphereBufferGeometry(radius, subdivision[0], subdivision[1], -Math.PI / 2); // thetaStart: -Math.PI/2
    sphereGeometry.userData = { 'x3dType': 'Sphere' };
    return sphereGeometry;
  }

  parsePlane(plane) {
    var size = convertStringToVec2(getNodeAttribute(plane, 'size', '1,1'));
    var planeGeometry = new THREE.PlaneBufferGeometry(size.x, size.y);
    planeGeometry.userData = { 'x3dType': 'Plane' };
    planeGeometry.rotateX(-Math.PI / 2);
    return planeGeometry;
  }

  parsePointSet(pointSet) {
    var coordinate = pointSet.getElementsByTagName('Coordinate')[0];
    var geometry = new THREE.BufferGeometry();
    geometry.userData = { 'x3dType': 'PointSet' };
    if (typeof coordinate === 'undefined')
      return geometry;

    var coordStrArray = getNodeAttribute(coordinate, 'point', '').trim().split(/\s/);
    var color = pointSet.getElementsByTagName('Color')[0];

    var count = coordStrArray.length;
    var colorStrArray;
    if (typeof color === 'undefined')
      colorStrArray = getNodeAttribute(color, 'color', '').trim().split(/\s/);
    if (typeof colorStrArray === 'undefined' && count !== colorStrArray.length) {
      count = Math.min(count, colorStrArray.length);
      console.error("X3DLoader:parsePointSet: 'coord' and 'color' fields size doesn't match.");
      geometry.userData.isColorPerVertex = false;
    } else
      geometry.userData.isColorPerVertex = true;

    var positions = new Float32Array(count);
    for (let i = 0; i < count; i++)
      positions[i] = parseFloat(coordStrArray[i]);
    geometry.addAttribute('position', new THREE.BufferAttribute(positions, 3));

    if (geometry.userData.isColorPerVertex) {
      var colors = new Float32Array(count);
      for (let i = 0; i < count; i++)
        colors[i] = parseFloat(colorStrArray[i]);
      geometry.addAttribute('color', new THREE.BufferAttribute(colors, 3));
    }

    geometry.computeBoundingBox();
    return geometry;
  }

  parseDirectionalLight(light) {
    var on = getNodeAttribute(light, 'on', 'true').toLowerCase() === 'true';
    if (!on)
      return;

    var color = convertStringTorgb(getNodeAttribute(light, 'color', '1 1 1'));
    var direction = convertStringToVec3(getNodeAttribute(light, 'direction', '0 0 -1'));
    var intensity = parseFloat(getNodeAttribute(light, 'intensity', '1'));
    var castShadows = getNodeAttribute(light, 'castShadows', 'false').toLowerCase() === 'true';

    var lightObject = new THREE.DirectionalLight(color.getHex(), intensity * 0.5);
    if (castShadows) {
      lightObject.castShadow = true;
      var shadowMapSize = parseFloat(getNodeAttribute(light, 'shadowMapSize', '1024'));
      lightObject.shadow.mapSize.width = shadowMapSize;
      lightObject.shadow.mapSize.height = shadowMapSize;
      lightObject.shadow.radius = parseFloat(getNodeAttribute(light, 'shadowsRadius', '1'));
      lightObject.shadow.bias = parseFloat(getNodeAttribute(light, 'shadowBias', '0'));
      lightObject.shadow.camera.near = parseFloat(getNodeAttribute(light, 'zNear', '0.001;'));
      lightObject.shadow.camera.far = parseFloat(getNodeAttribute(light, 'zFar', '2000'));
    }
    lightObject.position.set(-direction.x, -direction.y, -direction.z);
    lightObject.userData = { 'x3dType': 'DirectionalLight' };
    // Position of the directional light will be adjusted at the end of the load
    // based on the size of the scene so that all the objects are illuminated by this light.
    this.directionalLights.push(lightObject);
    return lightObject;
  }

  parsePointLight(light) {
    var on = getNodeAttribute(light, 'on', 'true').toLowerCase() === 'true';
    if (!on)
      return;

    var attenuation = convertStringToVec3(getNodeAttribute(light, 'attenuation', '1 0 0'));
    var color = convertStringTorgb(getNodeAttribute(light, 'color', '1 1 1'));
    var intensity = parseFloat(getNodeAttribute(light, 'intensity', '1'));
    var location = convertStringToVec3(getNodeAttribute(light, 'location', '0 0 0'));
    var radius = parseFloat(getNodeAttribute(light, 'radius', '100'));
    var castShadows = getNodeAttribute(light, 'castShadows', 'false').toLowerCase() === 'true';

    var lightObject = new THREE.PointLight(color.getHex(), intensity);
    lightObject.decay = attenuation.x;
    lightObject.distance = radius;
    if (castShadows) {
      lightObject.castShadow = true;
      var shadowMapSize = parseFloat(getNodeAttribute(light, 'shadowMapSize', '512'));
      lightObject.shadow.mapSize.width = shadowMapSize;
      lightObject.shadow.mapSize.height = shadowMapSize;
      lightObject.shadow.radius = parseFloat(getNodeAttribute(light, 'shadowsRadius', '1'));
      lightObject.shadow.bias = parseFloat(getNodeAttribute(light, 'shadowBias', '0'));
      lightObject.shadow.camera.near = parseFloat(getNodeAttribute(light, 'zNear', '0.001;'));
      lightObject.shadow.camera.far = radius;
    }
    lightObject.position.copy(location);
    lightObject.userData = { 'x3dType': 'PointLight' };
    return lightObject;
  }

  parseSpotLight(light, helperNodes) {
    var on = getNodeAttribute(light, 'on', 'true').toLowerCase() === 'true';
    if (!on)
      return;

    var attenuation = convertStringToVec3(getNodeAttribute(light, 'attenuation', '1 0 0'));
    var beamWidth = parseFloat(getNodeAttribute(light, 'beamWidth', '0.785'));
    var color = convertStringTorgb(getNodeAttribute(light, 'color', '1 1 1'));
    var cutOffAngle = parseFloat(getNodeAttribute(light, 'cutOffAngle', '0.785'));
    var direction = convertStringToVec3(getNodeAttribute(light, 'direction', '0 0 -1'));
    var intensity = parseFloat(getNodeAttribute(light, 'intensity', '1'));
    var location = convertStringToVec3(getNodeAttribute(light, 'location', '0 0 0'));
    var radius = parseFloat(getNodeAttribute(light, 'radius', '100'));
    var castShadows = getNodeAttribute(light, 'castShadows', 'false').toLowerCase() === 'true';

    var lightObject = new THREE.SpotLight(color.getHex(), intensity);
    lightObject.angle = cutOffAngle;
    if (beamWidth > cutOffAngle)
      lightObject.penumbra = 0.0;
    else
      lightObject.penumbra = 1.0 - (beamWidth / cutOffAngle);
    lightObject.decay = attenuation.x;
    lightObject.distance = radius;
    if (castShadows) {
      lightObject.castShadow = true;
      var shadowMapSize = parseFloat(getNodeAttribute(light, 'shadowMapSize', '512'));
      lightObject.shadow.mapSize.width = shadowMapSize;
      lightObject.shadow.mapSize.height = shadowMapSize;
      lightObject.shadow.radius = parseFloat(getNodeAttribute(light, 'shadowsRadius', '1'));
      lightObject.shadow.bias = parseFloat(getNodeAttribute(light, 'shadowBias', '0'));
      lightObject.shadow.camera.near = parseFloat(getNodeAttribute(light, 'zNear', '0.001;'));
      lightObject.shadow.camera.far = radius;
    }
    lightObject.position.copy(location);
    lightObject.target = new THREE.Object3D();
    lightObject.target.position.addVectors(lightObject.position, direction);
    lightObject.target.userData.x3dType = 'LightTarget';
    helperNodes.push(lightObject.target);
    lightObject.userData = { 'x3dType': 'SpotLight' };
    return lightObject;
  }

  parseBackground(background) {
    var color = convertStringTorgb(getNodeAttribute(background, 'skyColor', '0 0 0'));
    this.scene.scene.background = color;

    var hdrCubeMapUrl = getNodeAttribute(background, 'hdrUrl', undefined);
    var cubeTexture;
    if (typeof hdrCubeMapUrl !== 'undefined') {
      // TODO load HDR cube map.
      cubeTexture = new THREE.CubeTexture();
    } else {
      var cubeTextureEnabled = false;
      var attributeNames = ['leftUrl', 'rightUrl', 'topUrl', 'bottomUrl', 'backUrl', 'frontUrl'];
      var urls = [];
      for (let i = 0; i < 6; i++) {
        var url = getNodeAttribute(background, attributeNames[i], undefined);
        if (typeof url !== 'undefined') {
          cubeTextureEnabled = true;
          url = url.split(/['"\s]/).filter((n) => { return n; })[0];
        }
        urls.push(url);
      }

      if (cubeTextureEnabled) {
        cubeTexture = new THREE.CubeTexture();
        var missing = 0;
        for (let i = 0; i < 6; i++) {
          if (typeof urls[i] === 'undefined')
            continue;
          // Look for already loaded texture or load the texture in an asynchronous way.
          missing++;
          var image = TextureLoader.loadOrRetrieve(urls[i], cubeTexture, i);
          if (typeof image !== 'undefined') {
            cubeTexture.images[i] = image;
            missing--;
          }
        }
        this.scene.scene.background = cubeTexture;
        if (missing === 0)
          cubeTexture.needsUpdate = true;
      }
    }

    this.scene.scene.add(new THREE.AmbientLight(cubeTexture ? 0x404040 : color));

    return undefined;
  }

  parseViewpoint(viewpoint) {
    var fov = THREE.Math.radToDeg(parseFloat(getNodeAttribute(viewpoint, 'fieldOfView', '0.785'))) * 0.5;
    var near = parseFloat(getNodeAttribute(viewpoint, 'zNear', '0.1'));
    var far = parseFloat(getNodeAttribute(viewpoint, 'zFar', '2000'));
    if (typeof this.scene.viewpoint !== 'undefined') {
      this.scene.viewpoint.camera.fov = fov;
      this.scene.viewpoint.camera.near = near;
      this.scene.viewpoint.camera.far = far;
    } else {
      console.log('Parse Viewpoint: error camera');
      // Set default aspect ratio to 1. It will be updated on window resize.
      this.scene.viewpoint.camera = new THREE.PerspectiveCamera(fov, 1, near, far);
    }

    if ('position' in viewpoint.attributes) {
      var position = getNodeAttribute(viewpoint, 'position', '0 0 10');
      this.scene.viewpoint.camera.position.copy(convertStringToVec3(position));
    }
    if ('orientation' in viewpoint.attributes) {
      var quaternion = convertStringToQuaternion(getNodeAttribute(viewpoint, 'orientation', '0 1 0 0'));
      this.scene.viewpoint.camera.quaternion.copy(quaternion);
    }
    this.scene.viewpoint.camera.updateProjectionMatrix();

    // Set Webots specific attributes.
    this.scene.viewpoint.camera.userData.x3dType = 'Viewpoint';
    this.scene.viewpoint.camera.userData.followedId = getNodeAttribute(viewpoint, 'followedId', null);
    this.scene.viewpoint.camera.userData.followSmoothness = getNodeAttribute(viewpoint, 'followSmoothness', null);
    return undefined;
  }

  parseWorldInfo(worldInfo) {
    this.scene.worldInfo.title = getNodeAttribute(worldInfo, 'title', '');
    this.scene.worldInfo.window = getNodeAttribute(worldInfo, 'window', '');
  }

  parseFog(fog) {
    var colorInt = convertStringTorgb(getNodeAttribute(fog, 'color', '1 1 1')).getHex();
    var visibilityRange = parseFloat(getNodeAttribute(fog, 'visibilityRange', '0'));

    var fogObject = null;
    var fogType = getNodeAttribute(fog, 'forType', 'LINEAR');
    if (fogType === 'LINEAR')
      fogObject = new THREE.Fog(colorInt, 0.001, visibilityRange);
    else
      fogObject = new THREE.FogExp2(colorInt, 1.0 / visibilityRange);
    this.scene.scene.fog = fogObject;
    return undefined;
  }

  _setCustomId(node, object, defNode) {
    // Some THREE.js nodes, like the material and IndexedFaceSet, merges multiple X3D nodes.
    // In order to be able to retrieve the node to be updated, we need to assign to the object all the ids of the merged X3D nodes.
    if (!node || !object)
      return;
    var id = getNodeAttribute(node, 'id', undefined);
    if (typeof id !== 'undefined') {
      if (object.name !== '')
        object.name = object.name + ';' + String(id);
      else
        object.name = String(id);
      if (defNode) {
        if (typeof defNode.userData.USE === 'undefined')
          defNode.userData.USE = String(id);
        else
          defNode.userData.USE = defNode.userData.USE + ';' + String(id);
      }
    }
  }

  _getDefNode(node) {
    var useNodeId = getNodeAttribute(node, 'USE', undefined);
    if (typeof useNodeId === 'undefined')
      return undefined;

    // Look for node in previously parsed objects
    var defNode = this.scene.getObjectByCustomId(this.parsedObjects, useNodeId);
    if (typeof defNode !== 'undefined')
      return defNode;

    // Look for node in the already loaded scene
    defNode = this.scene.getObjectByCustomId(this.scene.root, useNodeId);
    if (typeof defNode === 'undefined')
      console.error('X3dLoader: no matching DEF node "' + useNodeId + '" node.');
    return defNode;
  }
};

function getNodeAttribute(node, attributeName, defaultValue) {
  console.assert(node && node.attributes);
  if (attributeName in node.attributes)
    return node.attributes.getNamedItem(attributeName).value;
  return defaultValue;
}

function createDefaultGeometry() {
  var geometry = new THREE.Geometry();
  geometry.userData = { 'x3dType': 'unknown' };
  return geometry;
};

function createDefaultMaterial(geometry) {
  var material;
  if (typeof geometry !== 'undefined' && geometry.userData.x3dType === 'PointSet' && geometry.userData.isColorPerVertex)
    material = new THREE.PointsMaterial({ size: 4, sizeAttenuation: false, vertexColors: THREE.VertexColors });
  else
    material = new THREE.MeshBasicMaterial({color: 0xffffff});
  return material;
};

function convertStringToVec2(s) {
  s = s.split(/\s/);
  var v = new THREE.Vector2(parseFloat(s[0]), parseFloat(s[1]));
  return v;
}

function convertStringToVec3(s) {
  s = s.split(/\s/);
  var v = new THREE.Vector3(parseFloat(s[0]), parseFloat(s[1]), parseFloat(s[2]));
  return v;
}

function convertStringToQuaternion(s) {
  var pos = s.split(/\s/);
  var q = new THREE.Quaternion();
  q.setFromAxisAngle(
    new THREE.Vector3(parseFloat(pos[0]), parseFloat(pos[1]), parseFloat(pos[2])),
    parseFloat(pos[3])
  );
  return q;
}

function convertStringTorgb(s) {
  var v = convertStringToVec3(s);
  return new THREE.Color(v.x, v.y, v.z);
}
