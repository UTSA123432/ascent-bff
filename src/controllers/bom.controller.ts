import {
  Count,
  CountSchema,
  Filter,
  FilterExcludingWhere,
  repository,
  Where,
} from '@loopback/repository';
import {inject} from "@loopback/core";
import {
  post,
  param,
  get,
  getModelSchemaRef,
  patch,
  del,
  requestBody,
  response,
  Response,
  oas,
  RestBindings,
  HttpErrors
} from '@loopback/rest';
import _ from 'lodash';
import { ArchitecturesBomController, ServicesController, AutomationCatalogController } from '.';
import {Bom} from '../models';
import { ArchitecturesRepository, BomRepository, ServicesRepository, ControlMappingRepository } from '../repositories';

import MarkdownPDF from 'markdown-pdf';
import fs from 'fs';
import path from 'path';
import { file } from 'nconf';

/* eslint-disable @typescript-eslint/naming-convention */
/* eslint-disable @typescript-eslint/no-explicit-any */

export class BomController {
  constructor(
    @repository(BomRepository)
    public bomRepository : BomRepository,
    @repository(ServicesRepository)
    public servicesRepository : ServicesRepository,
    @repository(ArchitecturesRepository) 
    protected architecturesRepository: ArchitecturesRepository,
    @repository(ControlMappingRepository) 
    protected controlMappingRepository: ControlMappingRepository,
  ) {}

  @post('/boms')
  @response(200, {
    description: 'Bom model instance',
    content: {'application/json': {schema: getModelSchemaRef(Bom)}},
  })
  async create(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Bom, {
            title: 'NewBom',
            exclude: ['_id'],
          }),
        },
      },
    })
    bom: Omit<Bom, '_id'>,
  ): Promise<Bom> {
    await this.servicesRepository.findById(bom['service_id']);
    return this.bomRepository.create(bom);
  }

  @get('/boms/count')
  @response(200, {
    description: 'Bom model count',
    content: {'application/json': {schema: CountSchema}},
  })
  async count(
    @param.where(Bom) where?: Where<Bom>,
  ): Promise<Count> {
    return this.bomRepository.count(where);
  }

  @get('/boms')
  @response(200, {
    description: 'Array of Bom model instances',
    content: {
      'application/json': {
        schema: {
          type: 'array',
          items: getModelSchemaRef(Bom, {includeRelations: true}),
        },
      },
    },
  })
  async find(
    @param.filter(Bom) filter?: Filter<Bom>,
  ): Promise<Bom[]> {
    return this.bomRepository.find(filter);
  }

  @patch('/boms')
  @response(200, {
    description: 'Bom PATCH success count',
    content: {'application/json': {schema: CountSchema}},
  })
  async updateAll(
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Bom, {partial: true}),
        },
      },
    })
    bom: Bom,
    @param.where(Bom) where?: Where<Bom>,
  ): Promise<Count> {
    return this.bomRepository.updateAll(bom, where);
  }

  @get('/boms/{id}')
  @response(200, {
    description: 'Bom model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(Bom, {includeRelations: true}),
      },
    },
  })
  async findById(
    @param.path.string('id') id: string,
    @param.filter(Bom, {exclude: 'where'}) filter?: FilterExcludingWhere<Bom>
  ): Promise<Bom> {
    return this.bomRepository.findById(id, filter);
  }

  @get('/boms/{id}/composite')
  @response(200, {
    description: 'composit API with service + catalog',
    content: {
      'application/json': {        
      },
    },
  })
  async findCompositeById(
    @param.path.string('id') id: string,
    @param.filter(Bom, {exclude: 'where'}) filter?: FilterExcludingWhere<Bom>
  ): Promise<any> {
    // eslint-disable-next-line prefer-const
    let bom =  await this.bomRepository.findById(id, filter);
    // eslint-disable-next-line prefer-const
    let jsonObj:any = JSON.parse(JSON.stringify(bom));
    // Get service data
    try {
      jsonObj.service = await (new ServicesController(this.servicesRepository,this.bomRepository,this.architecturesRepository, this.controlMappingRepository)).findById(bom.service_id, {"include":["controls"]});
      jsonObj.automation = await (new AutomationCatalogController(this.architecturesRepository,this.servicesRepository)).automationById(jsonObj.service.cloud_automation_id);
    }
    catch(e) {
      console.error(e);
    }
    // Get catalog data
    try {
      jsonObj.catalog = await (new ServicesController(this.servicesRepository,this.bomRepository,this.architecturesRepository, this.controlMappingRepository)).catalogByServiceId(bom.service_id);
    }
    catch(e) {
      console.error(e);
    }
    return jsonObj;
  }

  @get('/boms/{archid}/compliance-report')
  @response(200, {
    description: 'Download PDF compliance report based on the reference architecture BOM',
  })
  @oas.response.file()
  async downloadComplianceReport(
    @param.path.string('archid') archId: string,
    @inject(RestBindings.Http.RESPONSE) res: Response,
  ) {
    const arch = await this.architecturesRepository.findById(archId);
    const archBom = await this.architecturesRepository.boms(archId).find({ include: ['service'] });
    const archBomData = JSON.parse(JSON.stringify(archBom));
    const jsonObj = [];
    let md = `# ${arch.name} compliance report\n`;
    md += `## Services\n`;
    for await (const p of archBomData) {
      console.log(p);
      md += `### ${p.service.ibm_catalog_service ?? p.service.service_id}\n`;
    }
    let outputpath = `compliance-report.pdf`;
    return new Promise<Response>(async (resolve) => {
      MarkdownPDF().from.string(md).to(outputpath, () => {
        const file = this.validateFileName(outputpath);
        res.download(file, outputpath);
        resolve(res);
      });
    })
  }
  
  /**
   * Validate file names to prevent them goes beyond the designated directory
   * @param fileName - File name
   */
  private validateFileName(fileName: string) {
    const resolved = path.resolve(fileName);
    console.log(resolved);
    if (resolved) return resolved;
    // The resolved file is outside sandbox
    throw new HttpErrors.BadRequest(`Invalid file name: ${fileName}`);
  }

  @patch('/boms/{id}')
  @response(200, {
    description: 'Controls model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(Bom),
      },
    },
  })
  async updateById(
    @param.path.string('id') id: string,
    @requestBody({
      content: {
        'application/json': {
          schema: getModelSchemaRef(Bom, {partial: true}),
        },
      },
    })
    bom: Bom,
  ): Promise<Bom> {
    await this.bomRepository.updateById(id, bom);
    return this.bomRepository.findById(id);
  }

  @del('/boms/{id}')
  @response(204, {
    description: 'Bom DELETE success',
  })
  async deleteById(@param.path.string('id') id: string): Promise<void> {
    await this.bomRepository.deleteById(id);
  }

  @get('/boms/catalog/{bomId}')
  @response(200, {
    description: 'Bom model instance',
    content: {
      'application/json': {
        schema: getModelSchemaRef(Bom, {includeRelations: true}),
      },
    },
  })
  async compositeCatalogById(
    @param.path.string('bomId') bomId: string,
    @param.filter(Bom, {exclude: 'where'}) filter?: FilterExcludingWhere<Bom>
  ): Promise<any> {
    const bom_res = await this.bomRepository.findById(bomId, filter);
    const bom_serv_id = bom_res.service_id;        
    const bom_data = JSON.parse(JSON.stringify(bom_res));    
    console.log("*******bom_serv_id*********"+bom_serv_id);
    const serv_res = await (new ServicesController(this.servicesRepository,this.bomRepository,this.architecturesRepository, this.controlMappingRepository)).catalogByServiceId(bom_serv_id);    
    const srvc_data = JSON.parse(JSON.stringify(serv_res));    
  
    const result = _.merge(bom_data, srvc_data[0]);
    return result;
  }

  @get('/boms/services/{archid}')
  @response(200, {
    description: 'composit APi with bom + services + catalog',
    content: {
      'application/json': {        
      },
    },
  })
  async compositeCatalogByArchId(
    @param.path.string('archid') archid: string,    
  ): Promise<any> {    
    const arch_bom_res = await (new ArchitecturesBomController(this.architecturesRepository)).find(archid);
    const arch_bom_data = JSON.parse(JSON.stringify(arch_bom_res));
    const jsonObj = [];
    for await (const p of arch_bom_data) {
      console.log("*******p.service_id*********"+p.service_id);
      // Get service data
      try {
        p.service = await (new ServicesController(this.servicesRepository,this.bomRepository,this.architecturesRepository, this.controlMappingRepository)).findById(p.service_id);
        p.automation = await (new AutomationCatalogController(this.architecturesRepository,this.servicesRepository)).automationById(p.service.cloud_automation_id);
      }
      catch(e) {
        console.error(e);
      }
      // Get catalog data
      try {
        p.catalog = await (new ServicesController(this.servicesRepository,this.bomRepository,this.architecturesRepository, this.controlMappingRepository)).catalogByServiceId(p.service_id);
        jsonObj.push(p);
      }
      catch(e) {
        console.error(e);
        jsonObj.push(p);
      }
    }
    return jsonObj;
  }  
}
